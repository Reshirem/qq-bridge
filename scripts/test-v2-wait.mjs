// 验证桥接实际使用的消息未说完判定，不约束用户的等待配置。
import { looksLikeUnfinished } from '../src/v2-wait.js';

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed = 1;
  }
}

// 1. 未说完特征
const unfinishedCases = [
  '你知道',
  '等一下',
  '我跟你讲',
  '但是',
  '所以说',
  '然后',
  '那个',
  '就是',
  '我想说',
  '对了',
  '等我',
  '等等',
  '我看看',
  '还有',
  '再说',
  '主要是',
  '回头说',
  '待会',
  '再说吧',
  '你听我说，'
];
for (const text of unfinishedCases) {
  assert(looksLikeUnfinished(text) === true, `未说完判定 true: ${JSON.stringify(text)}`);
}

// 2. 已说完/普通消息不应误判
const finishedCases = [
  '',
  '好的',
  '今天好累',
  'B站搜猫踩奶视频 解压一绝',
  '那去看跳伞第一视角视频',
  '你再说一遍试试',
  '？',
  '哦牛批',
  '这么刺激',
  '你说完了。'
];
for (const text of finishedCases) {
  assert(looksLikeUnfinished(text) === false, `已说完/普通判定 false: ${JSON.stringify(text)}`);
}

if (failed) {
  console.error('\n❌ 测试失败');
  process.exit(1);
}
console.log('\n🎉 二代等待/结束回合逻辑测试通过');
