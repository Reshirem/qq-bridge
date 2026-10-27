// 合并转发消息能力自检脚本：
// 1. sanitizeForwardId 清洗规则
// 2. extractForwardIds 从 OneBot 消息段提取 forward id
// 3. formatForwardResponse / nodeText 格式化合并转发内容（含截断）
// 只验证转发消息解析与格式化辅助函数；桥接读取授权由全局 desktop-agent 令牌统一处理。
// 运行：node scripts/test-forward.mjs
import {
  sanitizeForwardId,
  extractForwardIds,
  formatForwardResponse,
  nodeText
} from '../src/forward.js';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. sanitizeForwardId
check('sanitizeForwardId 接受普通 id', sanitizeForwardId('abc_123-456') === 'abc_123-456');
check('sanitizeForwardId 接受常见符号', sanitizeForwardId('a/b:c=d+e@f.g') === 'a/b:c=d+e@f.g');
check('sanitizeForwardId 拒绝空白/控制字符', sanitizeForwardId('abc def') === '' && sanitizeForwardId('a\tb') === '');
check('sanitizeForwardId 拒绝超长 id', sanitizeForwardId('x'.repeat(300)) === '');
check('sanitizeForwardId 拒绝空值', sanitizeForwardId('') === '' && sanitizeForwardId(null) === '');

// 2. extractForwardIds
const segments = [
  { type: 'text', data: { text: '看这个' } },
  { type: 'forward', data: { id: 'fwd_001' } },
  { type: 'forward', data: { res_id: 'fwd_002' } },
  { type: 'forward', data: { id: 'fwd_001' } },
  { type: 'forward', data: { id: 'bad id' } }
];
const ids = extractForwardIds(segments);
check('extractForwardIds 提取并去重', JSON.stringify(ids) === JSON.stringify(['fwd_001', 'fwd_002']), JSON.stringify(ids));
check('extractForwardIds 忽略非法 id', !ids.includes('bad id'));
check('extractForwardIds 非数组返回空', JSON.stringify(extractForwardIds(null)) === '[]');

// 3. formatForwardResponse / nodeText
const data = {
  messages: [
    { sender: { nickname: '张三', user_id: 10001 }, time: 100006, message: [{ type: 'text', data: { text: '第一句' } }, { type: 'image', data: { url: 'https://example.com/a.jpg' } }, { type: 'forward', data: { id: 'nested_001' } }] },
    { sender: '李四', time: 100007, message: '第二句' },
    { sender: { card: '王五', user_id: 10003 }, time: 100008, content: [{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: ' 你好' } }] }
  ]
};
const fmt = formatForwardResponse(data);
check('formatForwardResponse.total=3', fmt.total === 3 && fmt.messages.length === 3);
check('formatForwardResponse 提取 sender/text', fmt.messages[0].sender === '张三' && fmt.messages[0].text === '第一句[图片][转发]');
check('formatForwardResponse 兼容字符串 message', fmt.messages[1].sender === '李四' && fmt.messages[1].text === '第二句');
check('nodeText 兼容 content 数组', nodeText(data.messages[2]) === '@10001 你好');
check('formatForwardResponse 暴露图片 media', fmt.messages[0].media.length === 1 && fmt.messages[0].media[0].url === 'https://example.com/a.jpg');
check('formatForwardResponse 暴露嵌套 forward id', JSON.stringify(fmt.messages[0].nestedForwardIds) === JSON.stringify(['nested_001']));
check('formatForwardResponse 暴露 messageId/messageSeq', fmt.messages[1].messageId === null && fmt.messages[1].messageSeq === null);

const truncated = formatForwardResponse(data, { maxMessages: 2, maxCharsPerMessage: 1 });
check('formatForwardResponse 截断 total/truncated', truncated.total === 3 && truncated.truncated === true && truncated.messages.length === 2);
check('formatForwardResponse 单条截断', truncated.messages[0].text.length <= 1);
check('formatForwardResponse textTruncated 标记', truncated.textTruncated === true);

const empty = formatForwardResponse({ messages: [] });
check('formatForwardResponse 空 messages', empty.total === 0 && empty.truncated === false && empty.messages.length === 0);

const senderFallback = formatForwardResponse({ messages: [{ sender: { nickname: '', card: '王五', user_id: 10003 }, message: 'x' }] });
check('sender 空 nickname 回退到 card', senderFallback.messages[0].sender === '王五');

const nodeData = { messages: [{ type: 'node', data: { name: '张三', uin: '10001', time: 100006, content: [{ type: 'text', data: { text: '你好' } }] } }] };
const fmtNode = formatForwardResponse(nodeData);
check('formatForwardResponse 兼容标准 node.data 结构', fmtNode.messages[0].sender === '张三' && fmtNode.messages[0].text === '你好' && fmtNode.messages[0].userId === '10001' && fmtNode.messages[0].time === 100006);

check('nodeText 清洗 CQ 字符串', nodeText({ message: '[CQ:image,file=x]' }) === '[媒体]');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
