'use strict';

/* ===================== 校园集市前端逻辑 ===================== */

const state = {
  user: null,
  categories: [],
  conditions: [],
  items: [],
  category: '',          // 当前分类筛选
  search: '',            // 当前搜索词
  sort: 'new',
  currentItem: null,     // 详情页商品
  galleryIndex: 0,
  images: [],            // 发布页待上传图片（base64）
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 工具 ---------------- */
function toast(msg, type = 'success') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = 'toast ' + type), 2400);
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) {
    const err = new Error(data.error || ('请求失败 (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data;
}

function avatarChar(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- 视图切换 ---------------- */
function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const target = $('#view-' + name);
  if (target) target.classList.remove('hidden');
  window.scrollTo({ top: 0 });
}

function navigate(name) {
  if (name === 'home') { state.category = ''; state.search = ''; $('#search-input').value = ''; renderCategories(); loadItems(); }
  else if (name === 'post') { if (!state.user) return showView('auth'); preparePostForm(); }
  else if (name === 'profile') { if (!state.user) return showView('auth'); loadMyItems(); }
  showView(name);
}

/* ---------------- 导航栏与登录态 ---------------- */
function renderNav() {
  const nav = $('#nav-actions');
  if (!state.user) {
    nav.innerHTML = `
      <button class="btn btn-primary" data-nav="auth">登录 / 注册</button>`;
  } else {
    nav.innerHTML = `
      <button class="btn btn-primary btn-sm" data-nav="post">＋ 发布</button>
      <div class="nav-user" data-nav="profile" style="cursor:pointer" title="查看我的">
        <span class="avatar">${escapeHtml(avatarChar(state.user.nickname))}</span>
        <span>${escapeHtml(state.user.nickname)}</span>
      </div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">退出</button>`;
  }
}

/* ---------------- 分类栏 ---------------- */
function renderCategories() {
  const bar = $('#category-bar');
  const chips = [
    `<button class="category-chip ${state.category === '' ? 'active' : ''}" data-category="">全部</button>`,
    ...state.categories.map((c) =>
      `<button class="category-chip ${state.category === c ? 'active' : ''}" data-category="${escapeHtml(c)}">${escapeHtml(c)}</button>`),
  ];
  bar.innerHTML = chips.join('');
}

/* ---------------- 商品列表 ---------------- */
function itemCard(item) {
  const thumb = item.images && item.images[0]
    ? `<img class="item-thumb" src="${escapeHtml(item.images[0])}" alt="${escapeHtml(item.title)}" loading="lazy" />`
    : `<div class="item-thumb placeholder">📦</div>`;
  const soldTag = item.status === 'sold' ? '<span class="tag sold">已售出</span>' : '';
  return `
    <article class="item-card" data-id="${item.id}">
      ${thumb}
      <div class="item-body">
        <div class="item-title">${escapeHtml(item.title)}</div>
        <div class="item-price">${Number(item.price).toFixed(2)}</div>
        <div class="item-meta">
          <span class="tag">${escapeHtml(item.category)}</span>
          ${soldTag}
          <span>${escapeHtml(item.cond)}</span>
        </div>
        <div class="item-seller">
          <span class="mini-avatar">${escapeHtml(avatarChar(item.seller.nickname))}</span>
          <span>${escapeHtml(item.seller.nickname)}</span>
        </div>
      </div>
    </article>`;
}

function renderItems() {
  const grid = $('#items-grid');
  grid.innerHTML = state.items.map(itemCard).join('');
  $('#empty-state').classList.toggle('hidden', state.items.length > 0);
}

async function loadItems() {
  try {
    const params = new URLSearchParams();
    if (state.category) params.set('category', state.category);
    if (state.search) params.set('search', state.search);
    if (state.sort) params.set('sort', state.sort);
    const data = await api('/api/items?' + params.toString());
    state.items = data.items;
    renderItems();
    const title = state.search
      ? `“${state.search}” 的搜索结果`
      : (state.category || '全部商品');
    $('#home-title').textContent = title;
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------------- 商品详情 ---------------- */
function renderDetail() {
  const item = state.currentItem;
  if (!item) return;
  state.galleryIndex = 0;
  const images = item.images || [];
  const gallery = images.length
    ? `
      <div class="detail-gallery">
        <img id="detail-img" src="${escapeHtml(images[0])}" alt="${escapeHtml(item.title)}" />
        ${images.length > 1 ? '<button class="gallery-nav prev">‹</button><button class="gallery-nav next">›</button>' : ''}
        ${images.length > 1 ? `<div class="gallery-dots">${images.map((_, i) => `<span class="${i === 0 ? 'active' : ''}"></span>`).join('')}</div>` : ''}
      </div>`
    : `<div class="detail-gallery" style="display:grid;place-items:center;font-size:72px">📦</div>`;

  const isMine = state.user && state.user.id === item.seller.id;
  const soldTag = item.status === 'sold' ? '<span class="tag sold">已售出</span>' : '';

  $('#detail-content').innerHTML = `
    <div class="detail-card">
      ${gallery}
      <div class="detail-info">
        <div class="detail-price">${Number(item.price).toFixed(2)}</div>
        <div class="detail-title">${escapeHtml(item.title)}</div>
        <div class="detail-meta">
          <span class="tag">${escapeHtml(item.category)}</span>
          <span class="tag">${escapeHtml(item.cond)}</span>
          ${soldTag}
          <span class="tag">${escapeHtml(item.location || '地点待定')}</span>
        </div>
        ${item.description ? `<div class="detail-desc">${escapeHtml(item.description)}</div>` : '<div class="detail-desc">卖家很懒，什么都没写～</div>'}
        <div class="detail-seller">
          <div class="avatar">${escapeHtml(avatarChar(item.seller.nickname))}</div>
          <div style="flex:1">
            <div class="name">${escapeHtml(item.seller.nickname)}</div>
            <div class="contact">联系方式：${escapeHtml(item.contact || '卖家未留')}</div>
            <div class="contact">发布时间：${new Date(item.created_at).toLocaleString('zh-CN')}</div>
          </div>
        </div>
        ${isMine ? `
          <div class="detail-actions">
            <button class="btn ${item.status === 'sold' ? 'btn-ghost' : 'btn-primary'}" id="toggle-sold">
              ${item.status === 'sold' ? '标记为在售' : '标记为已售出'}
            </button>
            <button class="btn btn-danger" id="delete-item">删除商品</button>
          </div>` : ''}
      </div>
    </div>`;

  // 图片轮播
  if (images.length > 1) {
    $('.gallery-nav.prev').addEventListener('click', () => stepGallery(-1));
    $('.gallery-nav.next').addEventListener('click', () => stepGallery(1));
  }
  if (isMine) {
    $('#toggle-sold').addEventListener('click', toggleSold);
    $('#delete-item').addEventListener('click', deleteItem);
  }
}

function stepGallery(dir) {
  const images = state.currentItem.images || [];
  if (images.length < 2) return;
  state.galleryIndex = (state.galleryIndex + dir + images.length) % images.length;
  $('#detail-img').src = images[state.galleryIndex];
  $$('.gallery-dots span').forEach((d, i) => d.classList.toggle('active', i === state.galleryIndex));
}

async function openDetail(id) {
  try {
    const data = await api('/api/items/' + id);
    state.currentItem = data.item;
    renderDetail();
    showView('detail');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function toggleSold() {
  const item = state.currentItem;
  const target = item.status === 'sold' ? 'available' : 'sold';
  try {
    await api(`/api/items/${item.id}/status`, { method: 'POST', body: { status: target } });
    item.status = target;
    renderDetail();
    toast(target === 'sold' ? '已标记为售出' : '已恢复为在售');
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteItem() {
  if (!confirm('确定删除这件商品吗？此操作不可恢复。')) return;
  try {
    await api('/api/items/' + state.currentItem.id, { method: 'DELETE' });
    toast('已删除');
    navigate('home');
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------- 发布商品 ---------------- */
function preparePostForm() {
  const catSel = $('#post-category');
  catSel.innerHTML = state.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const condSel = $('#post-cond');
  condSel.innerHTML = state.conditions.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  state.images = [];
  renderImagePreviews();
  $('#post-form').reset();
}

function renderImagePreviews() {
  const box = $('#image-previews');
  box.innerHTML = state.images.map((img, i) => `
    <div class="image-preview">
      <img src="${img}" alt="预览图 ${i + 1}" />
      <button type="button" class="remove" data-i="${i}" title="移除">×</button>
    </div>`).join('');
  $('#upload-btn').style.display = state.images.length >= 6 ? 'none' : '';
}

function handleImageSelect(e) {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    if (state.images.length >= 6) { toast('最多上传 6 张图片', 'error'); break; }
    if (file.size > 6 * 1024 * 1024) { toast(`“${file.name}” 超过 6MB`, 'error'); continue; }
    if (!/^image\//.test(file.type)) { toast(`“${file.name}” 不是图片`, 'error'); continue; }
    const reader = new FileReader();
    reader.onload = () => { state.images.push(reader.result); renderImagePreviews(); };
    reader.readAsDataURL(file);
  }
  e.target.value = '';
}

/* ---------------- 我的 ---------------- */
async function loadMyItems() {
  if (!state.user) return;
  try {
    const data = await api('/api/items?mine=1');
    $('#my-items-grid').innerHTML = data.items.map(itemCard).join('');
    $('#my-empty').classList.toggle('hidden', data.items.length > 0);
  } catch (e) { toast(e.message, 'error'); }
}

function renderProfile() {
  $('#profile-nickname').textContent = state.user.nickname;
  const meta = [state.user.username];
  if (state.user.phone) meta.push('📱 ' + state.user.phone);
  if (state.user.wechat) meta.push('💬 ' + state.user.wechat);
  $('#profile-meta').textContent = meta.join(' · ');
  $('#profile-avatar').textContent = avatarChar(state.user.nickname);
}

/* ---------------- 认证 ---------------- */
function switchAuthTab(tab) {
  $$('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.authTab === tab));
  $('#login-form').classList.toggle('hidden', tab !== 'login');
  $('#register-form').classList.toggle('hidden', tab !== 'register');
}

async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) return toast('请填写用户名和密码', 'error');
  try {
    const data = await api('/api/login', { method: 'POST', body: { username, password } });
    state.user = data.user;
    renderNav();
    toast('欢迎回来，' + data.user.nickname + '！');
    navigate('home');
  } catch (err) { toast(err.message, 'error'); }
}

async function handleRegister(e) {
  e.preventDefault();
  const form = e.target;
  const payload = {
    username: form.username.value.trim(),
    nickname: form.nickname.value.trim(),
    password: form.password.value,
    phone: form.phone.value.trim(),
    wechat: form.wechat.value.trim(),
  };
  if (!payload.username || !payload.password) return toast('请填写用户名和密码', 'error');
  if (payload.password.length < 6) return toast('密码至少 6 位', 'error');
  try {
    const data = await api('/api/register', { method: 'POST', body: payload });
    state.user = data.user;
    renderNav();
    toast('注册成功，欢迎加入校园集市！');
    navigate('home');
  } catch (err) { toast(err.message, 'error'); }
}

async function handleLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  state.user = null;
  renderNav();
  toast('已退出登录');
  navigate('home');
}

/* ---------------- 发布提交 ---------------- */
async function handlePost(e) {
  e.preventDefault();
  const form = e.target;
  const payload = {
    title: form.title.value.trim(),
    price: Number(form.price.value),
    category: form.category.value,
    cond: form.cond.value,
    description: form.description.value.trim(),
    location: form.location.value.trim(),
    contact: form.contact.value.trim(),
    images: state.images,
  };
  if (!payload.title) return toast('请填写标题', 'error');
  if (!Number.isFinite(payload.price) || payload.price < 0) return toast('请填写正确的价格', 'error');

  const btn = $('#post-submit');
  btn.disabled = true;
  btn.textContent = '发布中…';
  try {
    await api('/api/items', { method: 'POST', body: payload });
    toast('发布成功！');
    navigate('home');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '发布';
  }
}

/* ---------------- 事件委托 ---------------- */
function bindEvents() {
  // 导航
  document.addEventListener('click', (e) => {
    const navEl = e.target.closest('[data-nav]');
    if (navEl) {
      e.preventDefault();
      const name = navEl.dataset.nav;
      if (name === 'auth') { switchAuthTab('login'); showView('auth'); return; }
      navigate(name);
      return;
    }
    const tabEl = e.target.closest('[data-auth-tab]');
    if (tabEl) { e.preventDefault(); switchAuthTab(tabEl.dataset.authTab); return; }
    const chip = e.target.closest('[data-category]');
    if (chip) {
      state.category = chip.dataset.category;
      renderCategories();
      loadItems();
      return;
    }
    const card = e.target.closest('.item-card[data-id]');
    if (card) { openDetail(card.dataset.id); return; }
    const removeBtn = e.target.closest('.image-preview .remove');
    if (removeBtn) {
      state.images.splice(Number(removeBtn.dataset.i), 1);
      renderImagePreviews();
      return;
    }
  });

  $('#search-btn').addEventListener('click', doSearch);
  $('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('#sort-select').addEventListener('change', (e) => { state.sort = e.target.value; loadItems(); });
  $('#login-form').addEventListener('submit', handleLogin);
  $('#register-form').addEventListener('submit', handleRegister);
  $('#post-form').addEventListener('submit', handlePost);
  $('#image-input').addEventListener('change', handleImageSelect);
  document.addEventListener('click', (e) => {
    if (e.target.closest('#logout-btn')) handleLogout();
  });
}

function doSearch() {
  state.search = $('#search-input').value.trim();
  loadItems();
}

/* ---------------- 初始化 ---------------- */
async function init() {
  bindEvents();
  renderNav();
  try {
    const [me, cat] = await Promise.all([api('/api/me'), api('/api/categories')]);
    state.user = me.user;
    state.categories = cat.categories;
    state.conditions = cat.conditions;
  } catch { /* 后端未就绪时仍显示界面 */ }
  renderNav();
  renderCategories();
  if (state.user) navigate('home'); else showView('home');
  await loadItems();
}

init();
