'use strict';
/* 端到端冒烟测试：注册 → 登录 → 发布（含图片）→ 列表 → 详情 → 权限校验 → 删除 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function req(method, path, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
}

function extractSession(setCookie) {
  for (const c of setCookie) {
    const m = /^session=([^;]+)/.exec(c);
    if (m) return 'session=' + m[1];
  }
  return null;
}

(async () => {
  const uname = 'test_' + Date.now().toString(36);
  console.log('测试用户名:', uname, '\n');

  // 1. 未登录状态
  console.log('1. 未登录状态');
  let r = await req('GET', '/api/me');
  check('GET /api/me 返回 user=null', r.status === 200 && r.data.user === null);
  r = await req('GET', '/api/items');
  check('GET /api/items 公开可访问', r.status === 200 && Array.isArray(r.data.items));

  // 2. 注册
  console.log('2. 注册');
  r = await req('POST', '/api/register', { body: { username: uname, password: 'secret123', nickname: '测试同学', phone: '13800000000', wechat: 'test_wx' } });
  check('注册成功 201', r.status === 201, JSON.stringify(r.data));
  const cookie = extractSession(r.setCookie);
  check('注册后返回会话 Cookie', !!cookie);

  r = await req('POST', '/api/register', { body: { username: uname, password: 'secret123' } });
  check('重复用户名返回 409', r.status === 409, 'got ' + r.status);

  r = await req('POST', '/api/register', { body: { username: 'x', password: '1' } });
  check('非法用户名/密码被拒绝', r.status === 400, 'got ' + r.status);

  // 3. 登录
  console.log('3. 登录');
  r = await req('POST', '/api/login', { body: { username: uname, password: 'wrongpass' } });
  check('错误密码返回 401', r.status === 401, 'got ' + r.status);
  r = await req('POST', '/api/login', { body: { username: uname, password: 'secret123' } });
  check('正确密码登录成功 200', r.status === 200 && r.data.user && r.data.user.username === uname);

  // 4. 未登录发布商品应被拒绝
  console.log('4. 权限校验');
  r = await req('POST', '/api/items', { body: { title: '无主商品', price: 1, category: '其他' } });
  check('未登录发布商品返回 401', r.status === 401, 'got ' + r.status);

  // 5. 发布商品（含图片）
  console.log('5. 发布商品');
  r = await req('POST', '/api/items', {
    cookie,
    body: { title: '九成新高等数学教材', price: 15.5, category: '书籍教材', cond: '几乎全新', description: '只用过一个学期，几乎全新。', location: '图书馆', contact: '微信 test_wx', images: [PNG_1x1, PNG_1x1] },
  });
  check('发布商品成功 201', r.status === 201 && r.data.item && r.data.item.id > 0, JSON.stringify(r.data));
  const itemId = r.data.item && r.data.item.id;
  check('图片保存成功（2 张）', r.status === 201 && Array.isArray(r.data.item.images) && r.data.item.images.length === 2, JSON.stringify(r.data.item && r.data.item.images));

  // 6. 列表 / 搜索 / 筛选
  console.log('6. 列表与筛选');
  r = await req('GET', '/api/items');
  check('列表包含新商品', r.status === 200 && r.data.items.some((i) => i.id === itemId));
  r = await req('GET', '/api/items?category=' + encodeURIComponent('书籍教材'));
  check('按分类筛选正确', r.status === 200 && r.data.items.every((i) => i.category === '书籍教材'));
  r = await req('GET', '/api/items?search=' + encodeURIComponent('高等数学'));
  check('关键词搜索命中', r.status === 200 && r.data.items.some((i) => i.title.includes('高等数学')));
  r = await req('GET', '/api/items?mine=1', { cookie });
  check('mine=1 返回本人商品', r.status === 200 && r.data.items.some((i) => i.id === itemId));

  // 7. 详情
  console.log('7. 商品详情');
  r = await req('GET', '/api/items/' + itemId);
  check('详情返回正确', r.status === 200 && r.data.item.title.includes('高等数学') && r.data.item.seller.username === uname);

  // 8. 标记售出
  console.log('8. 状态变更');
  r = await req('POST', `/api/items/${itemId}/status`, { cookie, body: { status: 'sold' } });
  check('标记已售出', r.status === 200 && r.data.status === 'sold');

  // 9. 删除
  console.log('9. 删除商品');
  r = await req('DELETE', '/api/items/' + itemId, { cookie });
  check('本人删除成功', r.status === 200 && r.data.ok === true);
  r = await req('GET', '/api/items/' + itemId);
  check('删除后详情返回 404', r.status === 404, 'got ' + r.status);

  // 10. 退出登录
  console.log('10. 退出登录');
  r = await req('POST', '/api/logout', { cookie });
  check('退出成功', r.status === 200);

  console.log(`\n========== 测试结果：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(2);
});
