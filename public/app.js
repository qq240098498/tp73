// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  termRules: [],
  editingRuleId: '',
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区、文案区、用语区共用一套标记；
// 同名输入项可能在多个表单里各有一个（如备注），优先标到当前可见的那一个
function markField(field) {
  if (!field) return;
  const targets = Array.from(document.querySelectorAll(`[data-field="${field}"]`));
  if (!targets.length) return;
  const visible = targets.find((node) => !node.closest('.hidden') && node.offsetParent !== null) || targets[0];
  visible.classList.add('invalid');
  const input = visible.tagName === 'INPUT' || visible.tagName === 'SELECT' ? visible : visible.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
  renderTermLangOptions();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const fill = (select, current) => {
    const rows = ['<option value="">全部模块</option>']
      .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
    select.innerHTML = rows.join('');
    if (state.modules.some((item) => item.module === current)) select.value = current;
  };
  const entrySelect = el('filter-module');
  const termSelect = el('term-filter-module');
  const entryCurrent = entrySelect.value;
  const termCurrent = termSelect.value;
  fill(entrySelect, entryCurrent);
  fill(termSelect, termCurrent);
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '操作'])
    .map((text) => `<th>${escapeHtml(text)}</th>`)
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

function openEntryForm(entry) {
  state.editingId = entry ? entry.id : '';
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  el('entry-form').classList.remove('hidden');
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 语言与文案列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryEdit);
    if (found) openEntryForm(found);
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify('文案已删除', 'ok');
      await loadEntries();
      await loadLanguages();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

// ---------- 用语清单 ----------

async function loadTermRules() {
  const payload = await request('/api/term-rules');
  state.termRules = payload.rules || [];
  renderTermRules();
}

function languageName(code) {
  const found = state.languages.find((item) => item.code === code);
  return found ? `${found.name}（${code}）` : code;
}

function scopeText(rule) {
  if (rule.scopeType === 'all') return '全部语言';
  return rule.languages.map(languageName).join('、');
}

function renderTermRules() {
  const body = el('term-rule-body');
  body.innerHTML = state.termRules.map((rule) => {
    const typeTag = rule.type === 'unify'
      ? '<span class="tag term-unify">统一写法</span>'
      : '<span class="tag term-banned">禁用词</span>';
    const content = rule.type === 'unify'
      ? `「${escapeHtml(rule.from)}」<span class="arrow">→</span>「${escapeHtml(rule.to)}」`
      : `「${escapeHtml(rule.term)}」`;
    return `<tr>
      <td>${typeTag}</td>
      <td class="term-content">${content}</td>
      <td class="scope-cell">${escapeHtml(scopeText(rule))}</td>
      <td class="note-cell">${escapeHtml(rule.note)}</td>
      <td class="actions">
        <button type="button" class="link" data-term-edit="${escapeHtml(rule.id)}">编辑</button>
        <button type="button" class="link danger" data-term-delete="${escapeHtml(rule.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('term-rule-empty').classList.toggle('hidden', state.termRules.length > 0);
}

// 语言勾选项同时服务于检查条与规则表单；已选状态由调用方在生成后恢复
function langCheckboxes(containerId, name, disabled) {
  const box = el(containerId);
  box.innerHTML = state.languages.map((item) => {
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="check lang-pick">
      <input type="checkbox" name="${name}" value="${escapeHtml(item.code)}"${disabled ? ' disabled' : ''}>
      <span class="mono">${escapeHtml(item.code)}</span> ${suffix}
    </label>`;
  }).join('');
}

function renderTermLangOptions() {
  const allChecked = el('term-check-all').checked;
  langCheckboxes('term-check-langs', 'check-lang', allChecked);
  syncTermFormLangs();
}

// 规则表单里的语言勾选区只在“指定几种语言”时可用
function syncTermFormLangs(checked) {
  const specify = el('term-scope-langs').checked;
  const box = el('term-lang-checks');
  const previous = new Set();
  box.querySelectorAll('input').forEach((input) => { if (input.checked) previous.add(input.value); });
  langCheckboxes('term-lang-checks', 'rule-lang', !specify);
  const wanted = checked || previous;
  box.querySelectorAll('input').forEach((input) => {
    input.checked = wanted.has(input.value);
  });
}

function currentRuleType() {
  return el('term-type').value;
}

function toggleRuleTypeFields() {
  const unify = currentRuleType() === 'unify';
  el('term-unify-fields').classList.toggle('hidden', !unify);
  el('term-banned-fields').classList.toggle('hidden', unify);
}

function openRuleForm(rule) {
  state.editingRuleId = rule ? rule.id : '';
  el('term-form-title').textContent = rule ? '编辑规则' : '新增规则';
  el('term-type').value = rule ? rule.type : 'unify';
  el('term-from').value = rule && rule.type === 'unify' ? rule.from : '';
  el('term-to').value = rule && rule.type === 'unify' ? rule.to : '';
  el('term-word').value = rule && rule.type === 'banned' ? rule.term : '';
  el('term-note').value = rule ? rule.note : '';
  if (rule) {
    el('term-scope-all').checked = rule.scopeType === 'all';
    el('term-scope-langs').checked = rule.scopeType !== 'all';
    syncTermFormLangs(new Set(rule.scopeType === 'all' ? [] : rule.languages));
  } else {
    el('term-scope-all').checked = true;
    el('term-scope-langs').checked = false;
    syncTermFormLangs(new Set());
  }
  toggleRuleTypeFields();
  el('term-form').classList.remove('hidden');
  el('term-type').focus();
}

function closeRuleForm() {
  state.editingRuleId = '';
  el('term-form').classList.add('hidden');
  clearFieldMarks();
}

function selectedRuleLanguages() {
  return Array.from(document.querySelectorAll('#term-lang-checks input:checked')).map((input) => input.value);
}

async function submitTermRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const type = currentRuleType();
  const payload = {
    type,
    scopeType: el('term-scope-all').checked ? 'all' : 'languages',
    languages: selectedRuleLanguages(),
    note: el('term-note').value,
  };
  if (type === 'unify') {
    payload.from = el('term-from').value;
    payload.to = el('term-to').value;
  } else {
    payload.term = el('term-word').value;
  }
  const editing = state.editingRuleId;
  try {
    if (editing) {
      await request(`/api/term-rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('用语规则已保存', 'ok');
    } else {
      await request('/api/term-rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('用语规则已新增', 'ok');
    }
    closeRuleForm();
    await loadTermRules();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 把命中片段连同前后少量文字一起展示，片段本身高亮
function excerptHit(text, index, length) {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + length + 8);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${escapeHtml(text.slice(start, index))}<mark>${escapeHtml(text.slice(index, index + length))}</mark>${escapeHtml(text.slice(index + length, end))}${suffix}`;
}

async function runTermCheck(event) {
  event.preventDefault();
  clearNotice();
  document.querySelectorAll('#term-check-scope.invalid').forEach((node) => node.classList.remove('invalid'));

  const all = el('term-check-all').checked;
  const languages = all
    ? []
    : Array.from(document.querySelectorAll('#term-check-langs input:checked')).map((input) => input.value);
  if (!all && languages.length === 0) {
    notify('语言范围不能留空：勾选全部语言，或至少勾选一种语言', 'error');
    el('term-check-scope').classList.add('invalid');
    return;
  }

  const payload = { module: el('term-filter-module').value, languages };
  try {
    const result = await request('/api/term-rules/check', { method: 'POST', body: JSON.stringify(payload) });
    renderTermHits(result);
  } catch (err) {
    notify(err.message, 'error');
    if (err.field === 'languages') el('term-check-scope').classList.add('invalid');
  }
}

function renderTermHits(result) {
  const body = el('term-hit-body');
  body.innerHTML = result.hits.map((hit) => {
    const text = excerptHit(hit.translation, hit.index, hit.length);
    const ruleTag = hit.ruleType === 'unify'
      ? '<span class="tag term-unify">统一写法</span>'
      : '<span class="tag term-banned">禁用词</span>';
    const position = `第 ${hit.index + 1}–${hit.index + hit.length} 个字符`;
    return `<tr>
      <td class="mono">${escapeHtml(hit.module)}</td>
      <td class="mono">${escapeHtml(hit.key)}</td>
      <td class="mono">${escapeHtml(hit.language)}</td>
      <td class="hit-excerpt">${text}</td>
      <td>${ruleTag} <span class="rule-label">${escapeHtml(hit.ruleLabel)}</span></td>
      <td class="mono">${position}</td>
      <td>${hit.suggest ? `改为「${escapeHtml(hit.suggest)}」` : '不应出现，需要删除或改写'}</td>
    </tr>`;
  }).join('');

  const scopeLabel = result.scope.module ? `模块 ${result.scope.module}` : '全部模块';
  const summary = el('term-hit-summary');
  summary.classList.remove('hidden', 'ok');
  if (result.total > 0) {
    summary.textContent = `本次检查范围：${scopeLabel}、${result.checkedLanguages} 种语言、${result.checkedEntries} 条文案，共命中 ${result.total} 处，逐条列在下面。`;
  } else {
    summary.classList.add('ok');
    summary.textContent = `本次检查范围：${scopeLabel}、${result.checkedLanguages} 种语言、${result.checkedEntries} 条文案，没有命中任何用语规则。`;
  }
  el('term-hit-empty').classList.toggle('hidden', result.total > 0);
  el('term-hit-empty').textContent = result.total > 0 ? '' : '没有命中任何用语规则';
}

el('term-new').addEventListener('click', () => {
  clearNotice();
  openRuleForm(null);
});
el('term-cancel').addEventListener('click', closeRuleForm);
el('term-form').addEventListener('submit', submitTermRule);
el('term-check-bar').addEventListener('submit', runTermCheck);
el('term-type').addEventListener('change', toggleRuleTypeFields);
el('term-scope-all').addEventListener('change', () => syncTermFormLangs());
el('term-scope-langs').addEventListener('change', () => syncTermFormLangs());

el('term-check-all').addEventListener('change', () => {
  const all = el('term-check-all').checked;
  const inputs = document.querySelectorAll('#term-check-langs input');
  inputs.forEach((input) => {
    input.disabled = all;
    input.checked = false;
  });
});

document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;
  if (node.dataset.termEdit) {
    clearNotice();
    const rule = state.termRules.find((item) => item.id === node.dataset.termEdit);
    if (rule) openRuleForm(rule);
    return;
  }
  if (node.dataset.termDelete) {
    clearNotice();
    const rule = state.termRules.find((item) => item.id === node.dataset.termDelete);
    const label = rule ? (rule.type === 'unify' ? `「${rule.from}」→「${rule.to}」` : `禁用词「${rule.term}」`) : '';
    if (!window.confirm(`确定删除规则 ${label} 吗？`)) return;
    try {
      await request(`/api/term-rules/${encodeURIComponent(node.dataset.termDelete)}`, { method: 'DELETE' });
      if (state.editingRuleId === node.dataset.termDelete) closeRuleForm();
      notify('用语规则已删除', 'ok');
      await loadTermRules();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);
el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(() => Promise.all([loadEntries(), loadTermRules()]))
  .catch((err) => notify(err.message, 'error'));
