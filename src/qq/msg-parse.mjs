import fs from 'node:fs';
import path from 'node:path';
import { extOf, randomId } from '../util.mjs';

const CHAT_TYPE_GROUP = 2;
const CHAT_TYPE_C2C = 1;
const CHAT_TYPE_TEMP_GROUP = 100;

function chatTypeName (chatType) {
  if (chatType === CHAT_TYPE_GROUP) return 'group';
  if (chatType === CHAT_TYPE_C2C) return 'private';
  if (chatType === CHAT_TYPE_TEMP_GROUP) return 'temp';
  return 'other';
}

function stripXml (xml) {
  return String(xml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function parseJson (text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function grayTipKind (text, busiId, templId) {
  const t = String(text || '');
  if (String(templId) === '10382' || /赞了|点赞|表情/.test(t)) return 'emoji_like';
  if (/加入|入群|加群/.test(t)) return 'group_join';
  if (/退出|退群|离开/.test(t)) return 'group_leave';
  if (/移出|踢出|被移出/.test(t)) return 'group_kick';
  if (/头衔|称号/.test(t)) return 'group_title';
  if (/管理员|群主/.test(t)) return 'group_admin';
  if (String(busiId) === '2401') return 'essence';
  if (String(busiId) === '2000') return 'recall_guide';
  if (['2041', '2701'].includes(String(busiId))) return 'guide';
  return 'system';
}

function grayTipSegment (gray, selfInfo = {}) {
  const revoke = gray.revokeElement;
  if (revoke && (revoke.operatorUid || revoke.operatorNick || revoke.wording)) {
    return {
      type: 'recall',
      operator_uid: String(revoke.operatorUid || ''),
      operator_name: String(revoke.operatorNick || revoke.operatorRemark || revoke.operatorMemRemark || ''),
      is_self: Boolean(revoke.isSelfOperate),
      wording: String(revoke.wording || '')
    };
  }

  const jsonTip = gray.jsonGrayTipElement;
  if (jsonTip?.jsonStr) {
    const json = parseJson(jsonTip.jsonStr);
    const items = Array.isArray(json?.items) ? json.items : [];
    const people = items.filter(item => {
      if (!item) return false;
      const uid = String(item.uid || item.uin || '');
      const txt = String(item.txt || '');
      return uid && !/^https?:\/\//i.test(uid) && !/^https?:\/\//i.test(txt);
    });
    const text = items
      .map(item => String(item?.txt || ''))
      .filter(item => item && !/^https?:\/\//i.test(item))
      .join('')
      .trim();
    const actionMatch = String(jsonTip.jsonStr).match(/[?&]actionId=(\d+)/i);
    const actionValue = items.find(item => item?.actionId != null)?.actionId;
    const actionId = actionValue != null ? Number(actionValue) : actionMatch ? Number(actionMatch[1]) : null;

    if (String(jsonTip.busiId || '') === '1061' && people.length >= 1) {
      const hitSelf = actionId === 8;
      return {
        type: 'poke',
        busi_id: '1061',
        action_id: actionId,
        sender_uid: String(people[0].uid || people[0].uin || ''),
        sender_name: String(people[0].txt || ''),
        target_uid: hitSelf
          ? String(people[1]?.uid || people[1]?.uin || selfInfo.uid || selfInfo.uin || '')
          : String(people[1]?.uid || people[1]?.uin || ''),
        target_name: hitSelf
          ? String(people[1]?.txt || selfInfo.nick || '')
          : String(people[1]?.txt || ''),
        text
      };
    }
    return {
      type: 'gray_tip',
      kind: grayTipKind(text, jsonTip.busiId, ''),
      busi_id: String(jsonTip.busiId || ''),
      text: text || String(jsonTip.recentAbstract || '')
    };
  }

  const xml = gray.xmlElement;
  if (xml?.content) {
    const text = stripXml(xml.content);
    return {
      type: 'gray_tip',
      kind: grayTipKind(text, xml.busiId, xml.templId),
      busi_id: String(xml.busiId || ''),
      templ_id: String(xml.templId || ''),
      text
    };
  }

  return {
    type: 'gray_tip',
    kind: 'system',
    sub_type: Number(gray.subElementType || 0),
    text: ''
  };
}

function rawMessageText (raw) {
  const parts = [];
  for (const element of raw?.elements || []) {
    switch (Number(element.elementType)) {
      case 1: {
        const text = element.textElement?.content;
        if (text) parts.push(String(text));
        break;
      }
      case 2:
        parts.push('[图片]');
        break;
      case 3:
        parts.push(`[文件 ${element.fileElement?.fileName || ''}]`);
        break;
      case 4:
        parts.push(`[语音 ${Number(element.pttElement?.duration || 0)}s]`);
        break;
      case 5:
        parts.push('[视频]');
        break;
      case 6: {
        const face = element.faceElement || {};
        parts.push(Number(face.faceType) === 5 ? '[戳一戳]' : `[表情 ${face.faceText || ''}]`);
        break;
      }
      case 8: {
        const gray = grayTipSegment(element.grayTipElement || {}, {});
        parts.push(gray.type === 'poke' ? '[戳一戳]' : (gray.text || '[灰条消息]'));
        break;
      }
      case 11:
        parts.push(`[表情 ${element.marketFaceElement?.faceName || ''}]`);
        break;
      case 16:
        parts.push('[合并转发]');
        break;
      default:
        break;
    }
  }
  return parts.join('').trim().slice(0, 300);
}

async function resolveReply (ctx, raw, reply) {
  const service = ctx?.session?.getMsgService?.();
  if (!service) return null;
  const peer = { chatType: raw.chatType, peerUid: String(raw.peerUid || ''), guildId: '' };
  const seq = String(reply.seq || '');
  const id = String(reply.id || '');
  let rawReply = null;
  try {
    if (seq && seq !== '0' && typeof service.getMsgsBySeqAndCount === 'function') {
      const res = await service.getMsgsBySeqAndCount(peer, seq, 1, true, true);
      rawReply = res?.msgList?.[0];
    }
    if (!rawReply && id && id !== '0') {
      const res = await service.getMsgsByMsgId(peer, [id]);
      rawReply = res?.msgList?.[0];
    }
  } catch (error) {
    ctx.logger?.debug?.('[msg] 引用消息解析失败', error?.message || error);
  }
  if (!rawReply) return null;
  return {
    id: String(rawReply.msgId || id || ''),
    seq: String(rawReply.msgSeq || seq || ''),
    sender_uin: String(rawReply.senderUin || reply.sender_uin || ''),
    sender_name: String(rawReply.sendMemberName || rawReply.sendNickName || rawReply.sendRemarkName || ''),
    text: rawMessageText(rawReply)
  };
}

function attachmentKey (raw, element) {
  return `${raw.msgId}:${element.elementId}`;
}

export async function downloadAttachment (ctx, raw, element, options = {}) {
  const timeout = options.timeout || ctx.config.media.imageTimeoutMs || 20000;
  const tempPath = path.join(ctx.config._dataDir, 'tmp', `${randomId()}.bin`);
  fs.mkdirSync(path.dirname(tempPath), { recursive: true });

  const [, info] = await ctx.bus.call(
    'NodeIKernelMsgService/downloadRichMedia',
    'NodeIKernelMsgListener/onRichMediaDownloadComplete',
    [{
      fileModelId: '0',
      downSourceType: 0,
      downloadSourceType: 0,
      triggerType: 1,
      msgId: String(raw.msgId),
      chatType: raw.chatType,
      peerUid: String(raw.peerUid),
      elementId: String(element.elementId),
      thumbSize: 0,
      downloadType: 1,
      filePath: tempPath
    }],
    {
      dataCheck: arg => String(arg?.msgId) === String(raw.msgId) && String(arg?.msgElementId) === String(element.elementId),
      timeout
    }
  );

  const filePath = info?.filePath || tempPath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const name = element.fileElement?.fileName ||
    element.picElement?.fileName ||
    element.videoElement?.fileName ||
    element.pttElement?.fileName ||
    'file';
  return ctx.media.saveFile(filePath, name);
}

async function tryAutoDownload (ctx, raw, element, meta, enabled = true) {
  if (!enabled) return meta;
  const size = Number(element.picElement?.fileSize || element.fileElement?.fileSize || 0);
  if (size > Number(ctx.config.media.maxDownloadBytes || 0)) return meta;
  try {
    const saved = await downloadAttachment(ctx, raw, element, { timeout: ctx.config.media.imageTimeoutMs });
    if (!saved) return meta;
    return {
      ...meta,
      size: saved.size || size,
      local_path: saved.path,
      media_url: saved.url,
      md5: element.picElement?.md5HexStr || saved.md5
    };
  } catch (error) {
    ctx.logger?.warn('[msg] 图片下载失败', error?.message || error);
    return meta;
  }
}

export async function parseRawMessage (raw, ctx, options = {}) {
  const chatType = chatTypeName(raw.chatType);
  if (!['group', 'private', 'temp'].includes(chatType)) return null;

  const isSelf = String(raw.senderUin || '') === String(ctx.selfInfo.uin || '');
  const segments = [];

  for (const element of raw.elements || []) {
    switch (element.elementType) {
      case 1: {
        const text = element.textElement;
        if (!text) break;
        if (Number(text.atType) > 0) {
          segments.push({
            type: 'at',
            qq: String(text.atUid || ''),
            name: String(text.content || '').replace(/^@/, '')
          });
        } else if (text.content) {
          segments.push({ type: 'text', text: String(text.content) });
        }
        break;
      }
      case 2: {
        const pic = element.picElement || {};
        let meta = {
          type: 'image',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          file: pic.fileName || '',
          size: Number(pic.fileSize || 0),
          width: Number(pic.picWidth || 0),
          height: Number(pic.picHeight || 0),
          md5: pic.md5HexStr || '',
          url: pic.originImageUrl || ''
        };
        if (options.downloadImages && ctx.config.media.autoDownloadImages !== false) {
          meta = await tryAutoDownload(ctx, raw, element, meta, true);
        }
        segments.push(meta);
        break;
      }
      case 3: {
        const file = element.fileElement || {};
        let meta = {
          type: 'file',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: file.fileName || '',
          size: Number(file.fileSize || 0),
          path: file.filePath || '',
          md5: file.fileMd5 || ''
        };
        if (options.downloadFiles && ctx.config.media.autoDownloadFiles !== false) {
          meta = await tryAutoDownload(ctx, raw, element, meta, true);
        }
        segments.push(meta);
        break;
      }
      case 4: {
        const ptt = element.pttElement || {};
        segments.push({
          type: 'voice',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: ptt.fileName || '',
          size: Number(ptt.fileSize || 0),
          duration: Number(ptt.duration || 0),
          path: ptt.filePath || ''
        });
        break;
      }
      case 5: {
        const video = element.videoElement || {};
        segments.push({
          type: 'video',
          element_id: element.elementId,
          attachment_id: attachmentKey(raw, element),
          name: video.fileName || '',
          size: Number(video.fileSize || 0),
          duration: Number(video.fileTime || 0),
          width: Number(video.fileWidth || 0),
          height: Number(video.fileHeight || 0),
          path: video.filePath || ''
        });
        break;
      }
      case 6: {
        const face = element.faceElement || {};
        if (Number(face.faceType) === 5 || face.pokeType != null) {
          const poke = {
            type: 'poke',
            poke_type: Number(face.pokeType || 0),
            face_index: Number(face.faceIndex || 0),
            text: face.faceText || ''
          };
          if (chatType === 'private') {
            poke.sender_uin = String(raw.senderUin || '');
            poke.sender_name = String(raw.sendMemberName || raw.sendNickName || raw.sendRemarkName || '');
            poke.target_uin = isSelf ? String(raw.peerUin || raw.peerUid || '') : String(ctx.selfInfo.uin || '');
            poke.target_name = isSelf ? String(raw.peerName || '') : String(ctx.selfInfo.nick || '');
          }
          segments.push(poke);
        } else {
          segments.push({
            type: 'face',
            id: Number(face.faceIndex || 0),
            text: face.faceText || '',
            face_type: Number(face.faceType || 0)
          });
        }
        break;
      }
      case 7: {
        const reply = element.replyElement || {};
        segments.push({
          type: 'reply',
          id: String(reply.replayMsgId || ''),
          seq: String(reply.replayMsgSeq || ''),
          sender_uin: String(reply.senderUin || '')
        });
        break;
      }
      case 8: {
        const gray = element.grayTipElement;
        if (!gray) {
          segments.push({ type: 'gray_tip', kind: 'system', text: '' });
          break;
        }
        segments.push(grayTipSegment(gray, ctx.selfInfo || {}));
        break;
      }
      case 9:
        segments.push({ type: 'wallet' });
        break;
      case 10:
        segments.push({ type: 'ark' });
        break;
      case 11: {
        const market = element.marketFaceElement || {};
        const emojiId = String(market.emojiId || '');
        segments.push({
          type: 'market_face',
          name: String(market.faceName || ''),
          emoji_id: emojiId,
          package_id: Number(market.emojiPackageId || 0),
          url: emojiId
            ? `https://gxh.vip.qq.com/club/item/parcel/item/${emojiId.slice(0, 2)}/${emojiId}/raw300.gif`
            : ''
        });
        break;
      }
      case 12:
        segments.push({ type: 'live_gift' });
        break;
      case 13:
        segments.push({ type: 'long_msg' });
        break;
      case 16:
        segments.push({
          type: 'forward',
          summary: element.multiForwardMsgElement?.resId ? '合并转发' : '',
          res_id: element.multiForwardMsgElement?.resId || ''
        });
        break;
      default:
        segments.push({ type: 'unknown', element_type: element.elementType });
    }
  }

  const replySegment = segments.find(segment => segment.type === 'reply');
  if (replySegment && !options.skipReplyResolve) {
    const resolved = await resolveReply(ctx, raw, replySegment);
    if (resolved) Object.assign(replySegment, resolved);
  }

  return {
    id: String(raw.msgId),
    time: Number(raw.msgTime || 0),
    seq_qq: String(raw.msgSeq || ''),
    chat_type: chatType,
    conversation: {
      id: chatType === 'group' ? String(raw.peerUin || raw.peerUid) : String(raw.peerUid),
      qq: String(raw.peerUin || ''),
      name: String(raw.peerName || '')
    },
    sender: {
      uin: String(raw.senderUin || ''),
      uid: String(raw.senderUid || ''),
      name: String(raw.sendMemberName || raw.sendNickName || raw.sendRemarkName || '')
    },
    self: isSelf,
    segments
  };
}
