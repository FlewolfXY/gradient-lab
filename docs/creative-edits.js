/**
 * Bounded, deterministic score editing. The text helper is a LOCAL RULE PARSER,
 * not an AI model. A model adapter may produce the same validated plan schema.
 * Events use [beat, duration, MIDI note, velocity, optional visual position].
 */
export const EDIT_SCOPES = Object.freeze(['all', 'firstHalf', 'secondHalf', 'ending']);
export const MAX_EDIT_PLANS = 8;
export const EDIT_TYPES = Object.freeze(['sparser', 'softer', 'brighter', 'slower', 'faster', 'fadeEnding', 'airy']);
const SCOPE_NAMES = { all: '全曲', firstHalf: '前半段', secondHalf: '后半段', ending: '最后四小节' };
const DEFAULTS = { sparser: 0.5, softer: 0.72, brighter: 12, slower: 0.85, faster: 1.15, fadeEnding: 0.25 };
const LIMITS = { sparser: [0.25, 0.75], softer: [0.25, 0.9], brighter: [12, 12], slower: [0.6, 0.95], faster: [1.05, 1.5], fadeEnding: [0.1, 0.5] };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = n => Math.round(n * 10000) / 10000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function assertKeys(value, allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('修改计划含有不支持的字段');
}

/** Validates completely: no unknown operations, scripts, silent coercion or truncation. */
export function normalizeEditPlan(input) {
  if (!isObject(input)) throw new TypeError('修改计划必须是对象');
  assertKeys(input, ['v', 'scope', 'lockMelody', 'operations']);
  if (input.v !== undefined && input.v !== 1) throw new TypeError('修改计划版本不支持');
  const scope = input.scope ?? 'all', lockMelody = input.lockMelody ?? true;
  if (!EDIT_SCOPES.includes(scope) || typeof lockMelody !== 'boolean') throw new TypeError('修改范围或旋律锁定无效');
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 5) throw new TypeError('每次支持 1–5 项修改');
  const types = new Set();
  const operations = input.operations.map(operation => {
    if (!isObject(operation)) throw new TypeError('修改动作无效');
    assertKeys(operation, ['type', 'amount', 'preset']);
    const { type } = operation;
    if (!EDIT_TYPES.includes(type) || types.has(type)) throw new TypeError('修改动作未知或重复');
    types.add(type);
    if (['slower', 'faster', 'airy'].includes(type) && scope !== 'all') throw new TypeError('速度与音色目前只能修改全曲');
    if (type === 'brighter' && lockMelody) throw new TypeError('提高旋律音区需要先解锁旋律');
    if (type === 'fadeEnding' && scope === 'firstHalf') throw new TypeError('结尾渐弱不能只作用于前半段');
    if (type === 'airy') {
      if (operation.amount !== undefined || !['ice', 'forest'].includes(operation.preset ?? 'ice')) throw new TypeError('音色选择无效');
      return { type, preset: operation.preset ?? 'ice' };
    }
    if (operation.preset !== undefined) throw new TypeError('这个动作不接受音色参数');
    const amount = operation.amount ?? DEFAULTS[type];
    const [lo, hi] = LIMITS[type];
    if (!Number.isFinite(amount) || amount < lo || amount > hi) throw new TypeError('修改强度超出支持范围');
    return { type, amount: round(amount) };
  });
  if (types.has('slower') && types.has('faster')) throw new TypeError('不能同时加快与放慢');
  return { v: 1, scope, lockMelody, operations };
}

function boundsFor(result, scope) {
  const end = result.bars * 4;
  if (scope === 'firstHalf') return [0, end / 2];
  if (scope === 'secondHalf') return [end / 2, end];
  if (scope === 'ending') return [Math.max(0, end - 16), end];
  return [0, end];
}
// Generator adds tiny human timing offsets: a note at 31.995 belongs to bar 9,
// not bar 8. Snap only for selection; retain every original onset in the output.
const selectionBeat = event => Math.abs(event[0] - Math.round(event[0])) < 0.04 ? Math.round(event[0]) : event[0];
function inBounds(event, [start, end]) { const beat = selectionBeat(event); return beat >= start && beat < end; }
function copyEvent(event) { return event.map(value => Array.isArray(value) ? [...value] : value); }
function copyResult(result) {
  return { ...result, tracks: Object.fromEntries(Object.entries(result.tracks).map(([name, events]) => [name, events.map(copyEvent)])) };
}

/** Returns a fresh score; metadata and visual mapping are retained from the source. */
export function applyEditPlan(baseResult, input) {
  const plan = normalizeEditPlan(input);
  if (!isObject(baseResult) || !isObject(baseResult.tracks) || !Number.isFinite(baseResult.bars) || baseResult.bars < 1 || !Number.isFinite(baseResult.tempo)) throw new TypeError('请先生成一首有效的小曲');
  const result = copyResult(baseResult), changes = [];
  const scopeBounds = boundsFor(result, plan.scope);
  const targets = ['melody', 'chords', 'bass'].filter(name => !(plan.lockMelody && name === 'melody') && Array.isArray(result.tracks[name]));
  let preset;
  for (const operation of plan.operations) {
    const { type, amount } = operation;
    if (type === 'slower' || type === 'faster') {
      const before = result.tempo;
      result.tempo = clamp(Math.round(before * amount), 50, 120);
      changes.push(`全曲速度：${before} → ${result.tempo} BPM；音符与拍数保持不变`);
      continue;
    }
    if (type === 'airy') {
      preset = operation.preset;
      changes.push(`全曲音色：${preset === 'forest' ? '潮湿森林 · 温暖木质' : '冰蓝透明 · 玻璃钟声'}；音符保持不变`);
      continue;
    }
    if (type === 'sparser') {
      let removed = 0;
      for (const name of targets) {
        const events = result.tracks[name];
        const groups = new Map();
        events.forEach((event, index) => {
          if (!inBounds(event, scopeBounds)) return;
          const key = name === 'chords' ? Math.round(selectionBeat(event) * 100) : Math.floor(selectionBeat(event) / 4);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(index);
        });
        const drop = new Set();
        for (const indices of groups.values()) {
          // Preserve at least one event in every bar/chord and the root/first hit.
          if (indices.length < 2) continue;
          const candidates = indices.slice(1);
          // Prefer offbeat melody events, highest chord tones, later bass hits.
          if (name === 'chords') candidates.sort((a, b) => events[b][2] - events[a][2]);
          else if (name === 'melody') candidates.sort((a, b) => {
            const offA = Math.abs(selectionBeat(events[a]) % 1) > 0.04 ? 1 : 0;
            const offB = Math.abs(selectionBeat(events[b]) % 1) > 0.04 ? 1 : 0;
            return offB - offA || b - a;
          });
          const count = Math.min(candidates.length, Math.max(1, Math.floor(indices.length * amount)));
          candidates.slice(0, count).forEach(index => drop.add(index));
        }
        result.tracks[name] = events.filter((_, index) => !drop.has(index));
        removed += drop.size;
      }
      changes.push(`${SCOPE_NAMES[plan.scope]}减少 ${removed} 个${plan.lockMelody ? '伴奏' : ''}音符，保留每小节的支点`);
      continue;
    }
    let changed = 0;
    const fadeBounds = [Math.max(scopeBounds[0], result.bars * 4 - 16), scopeBounds[1]];
    for (const name of targets) {
      if (type === 'brighter' && name !== 'melody') continue;
      result.tracks[name] = result.tracks[name].map(event => {
        if (!inBounds(event, type === 'fadeEnding' ? fadeBounds : scopeBounds)) return event;
        const updated = copyEvent(event);
        if (type === 'brighter' && event[2] + amount <= 96) updated[2] = event[2] + amount;
        if (type === 'softer') updated[3] = clamp(Math.round(event[3] * amount), 1, 127);
        if (type === 'fadeEnding') {
          const length = Math.max(4, fadeBounds[1] - fadeBounds[0]);
          const progress = clamp((selectionBeat(event) - fadeBounds[0]) / Math.max(1, length - 4), 0, 1);
          updated[3] = clamp(Math.round(event[3] * (1 - progress * (1 - amount))), 1, 127);
        }
        if (updated[2] !== event[2] || updated[3] !== event[3]) changed++;
        return updated;
      });
    }
    if (type === 'softer') changes.push(`${SCOPE_NAMES[plan.scope]}${plan.lockMelody ? '伴奏' : ''}力度降至约 ${Math.round(amount * 100)}%（${changed} 个音符）`);
    if (type === 'brighter') changes.push(`${SCOPE_NAMES[plan.scope]}旋律提高一个八度，最高到 MIDI 96（${changed} 个音符）`);
    if (type === 'fadeEnding') changes.push(`最后四小节${plan.lockMelody ? '伴奏' : ''}渐弱至约 ${Math.round(amount * 100)}%（${changed} 个音符）`);
  }
  if (plan.lockMelody) changes.push('旋律已锁定：音高、起点、时值与力度均保留；全曲调速仍会改变实际播放时长');
  return { result, changes, ...(preset ? { preset } : {}) };
}

export function normalizeEditPlans(plans) {
  if (!Array.isArray(plans) || plans.length > MAX_EDIT_PLANS) throw new TypeError('最多保留 8 步修改');
  return plans.map(normalizeEditPlan);
}
export function replayEditPlans(baseResult, inputs = []) {
  const plans = normalizeEditPlans(inputs);
  let result = copyResult(baseResult), changes = [], preset;
  for (const plan of plans) {
    const applied = applyEditPlan(result, plan);
    result = applied.result; changes.push(...applied.changes);
    if (applied.preset) preset = applied.preset;
  }
  return { result, changes, ...(preset ? { preset } : {}) };
}

/** Compact ASCII wire format. Invalid or oversized input is rejected, never executed. */
export function encodeEditPlans(inputs = []) {
  return JSON.stringify(normalizeEditPlans(inputs).map(plan => [
    EDIT_SCOPES.indexOf(plan.scope), plan.lockMelody ? 1 : 0,
    plan.operations.map(op => [EDIT_TYPES.indexOf(op.type), op.type === 'airy' ? (op.preset === 'forest' ? 1 : 0) : op.amount]),
  ]));
}
export function decodeEditPlans(text = '') {
  if (!text) return [];
  if (typeof text !== 'string' || text.length > 4096) throw new TypeError('分享中的修改记录过长');
  const input = JSON.parse(text);
  if (!Array.isArray(input) || input.length > MAX_EDIT_PLANS) throw new TypeError('分享中的修改记录无效');
  return normalizeEditPlans(input.map(row => {
    if (!Array.isArray(row) || row.length !== 3 || !Number.isInteger(row[0]) || !EDIT_SCOPES[row[0]] || ![0, 1].includes(row[1]) || !Array.isArray(row[2])) throw new TypeError('分享中的修改记录无效');
    return { scope: EDIT_SCOPES[row[0]], lockMelody: Boolean(row[1]), operations: row[2].map(op => {
      if (!Array.isArray(op) || op.length !== 2 || !Number.isInteger(op[0]) || !EDIT_TYPES[op[0]]) throw new TypeError('分享中的动作无效');
      const type = EDIT_TYPES[op[0]];
      if (type === 'airy') {
        if (![0, 1].includes(op[1])) throw new TypeError('分享中的音色无效');
        return { type, preset: op[1] ? 'forest' : 'ice' };
      }
      return { type, amount: op[1] };
    }) };
  }));
}

/**
 * Deliberately small vocabulary. Unknown or ambiguous requests stay unexecuted.
 * The UI must label this as local rules, and show the plan before accepting it.
 */
export function parseLocalIntent(text, options = {}) {
  const response = (status, message, extra = {}) => ({ status, source: 'local-rules', summary: message, message, ...extra });
  if (typeof text !== 'string' || !text.trim()) return response('unsupported', '写下一个具体调整，例如“后半段留白一点”。');
  if (text.length > 300) return response('unsupported', '请把这次修改缩短到 300 字以内。');
  let remaining = text.trim().toLowerCase(), scope = options.scope ?? 'all', lockMelody = options.lockMelody ?? true;
  if (!EDIT_SCOPES.includes(scope) || typeof lockMelody !== 'boolean') return response('unsupported', '请选择有效的范围和旋律锁定状态。');
  const replace = (pattern, callback = () => {}) => { remaining = remaining.replace(pattern, match => { callback(match); return ' '; }); };
  // Explicit protection phrases are handled before generic negation detection.
  let requestedLock = false, requestedUnlock = false;
  replace(/(?:保留|锁定|保持)(?:原来(?:的)?|原有(?:的)?|现在(?:的)?|这段(?:的)?)?旋律(?:不变)?|(?:不要|别|不)(?:改动|改变|改|动)旋律|旋律(?:保持不变|不变|别动)/g, () => { lockMelody = true; requestedLock = true; });
  if (/(?:解锁|可以(?:改动|改变|改)|允许(?:改动|改变|改))旋律/.test(remaining)) {
    replace(/(?:解锁|可以(?:改动|改变|改)|允许(?:改动|改变|改))旋律/g, () => { lockMelody = false; requestedUnlock = true; });
  }
  if (requestedLock && requestedUnlock) return response('clarify', '这次同时要求保留和修改旋律，请先确定是否锁定旋律。');
  const foundScopes = new Set();
  replace(/前半段|前半部分|上半段|开头一半/g, () => foundScopes.add('firstHalf'));
  replace(/后半段|后半部分|下半段|后面一半/g, () => foundScopes.add('secondHalf'));
  replace(/最后(?:的)?四小节|最后4小节|结尾|尾声/g, () => foundScopes.add('ending'));
  replace(/全曲|整首|整段|整体/g, () => foundScopes.add('all'));
  if (foundScopes.size > 1) return response('clarify', '这次出现了多个修改范围，请分两步修改，先选一个范围。');
  if (foundScopes.size) scope = [...foundScopes][0];
  if (/(?:不要|不能|别|不想|不需要|不必|不再|无需)/.test(remaining)) return response('clarify', '我看到了否定要求。请保留旋律锁定，并用正向动作说明其余修改，例如“伴奏轻一点”。');
  const operations = [], names = [], airyChoices = new Set();
  function add(type, name, extra = {}) { if (type === 'airy') airyChoices.add(extra.preset); if (!operations.some(op => op.type === type)) { operations.push({ type, ...extra }); names.push(name); } }
  replace(/(?:慢慢|逐渐|渐渐)(?:地)?(?:安静下来|变轻|轻下来|弱下来|变弱|淡出)|渐弱|淡出|慢慢收尾/g, () => add('fadeEnding', '结尾渐弱'));
  replace(/稀疏|疏朗|疏一点|留白|留(?:一点|一些|点)?空(?:间)?|少(?:一些|一点|点)?(?:音符|声音)|(?:音符|伴奏)(?:太满|太密|太多)|(?:太满|太密)/g, () => add('sparser', '减少密度'));
  replace(/柔和|轻柔|轻一点|轻一些|轻点|温柔|柔软|小声|安静一点|安静一些|降低(?:音量|力度)|(?:音量|力度)(?:低一点|小一点)/g, () => add('softer', '降低力度'));
  replace(/明亮|亮一点|亮一些|亮点|提高(?:旋律)?音区|高一个八度/g, () => add('brighter', '提高旋律音区'));
  replace(/放慢|慢一点|慢一些|慢点|更慢|降低速度|速度降低/g, () => add('slower', '放慢速度'));
  replace(/加快|快一点|快一些|快点|更快|提高速度|速度提高/g, () => add('faster', '加快速度'));
  replace(/(?:像)?(?:隔着|隔了一层)(?:薄)?雾|朦胧|空灵|空气感|玻璃(?:般的)?(?:声音|钟声|音色)?|冰蓝透明/g, () => add('airy', '换成冰蓝透明音色', { preset: 'ice' }));
  replace(/森林(?:般的)?(?:声音|音色)?|木质(?:的)?(?:声音|音色)?|暖一点|温暖/g, () => add('airy', '换成潮湿森林音色', { preset: 'forest' }));
  if (airyChoices.size > 1) return response('clarify', '玻璃与木质是两种不同音色，请先选择一种。');
  if (operations.some(op => op.type === 'slower') && operations.some(op => op.type === 'faster')) return response('clarify', '你同时提到了加快和放慢，这次希望选哪一个？');
  if (operations.some(op => op.type === 'fadeEnding') && scope === 'firstHalf') return response('clarify', '“结尾渐弱”会作用于最后四小节。请把范围改为结尾，或分两步修改。');
  // Accept conversational glue, but do not pretend to understand unrecognized
  // musical demands, target durations, numbers, keys, instruments or styles.
  replace(/请|帮我|我想要|我希望|我想|想要|希望|可以|能不能|能否|把|让|变得|变成|变|调整成|调整|听起来|听着|音乐|声音|曲子|这首|这段|这一段|这里|那里|伴奏|旋律|节奏|速度|一点|一些|点|稍微|稍稍|再|更|有点|有些|太|一下|一些些|同时|然后|并且|但是|不过|还有|以及|而且|也|并|和|与|地|的|得|了|吧|呀|啊|哦|嘛|呢|就|只|给它|给我/g);
  remaining = remaining.replace(/[\s，。！？、；：,.!?;:()（）“”"'—-]/g, '');
  if (remaining || !operations.length) return response('unsupported', '这次还不能准确理解。可以试“后半段留白一点”“伴奏轻一点”“结尾渐弱”，或直接选一个调整按钮。');
  if (operations.some(op => ['slower', 'faster', 'airy'].includes(op.type)) && scope !== 'all') return response('clarify', '速度与音色目前会影响全曲。请选“全曲”，或只调整所选片段的密度与力度。');
  if (operations.some(op => op.type === 'brighter') && lockMelody) return response('clarify', '“明亮”这里会把旋律提高一个八度。请先解锁旋律，或选择只换音色。');
  try {
    const plan = normalizeEditPlan({ scope, lockMelody, operations });
    return response('ready', `${SCOPE_NAMES[scope]}：${names.join('、')}；${lockMelody ? '保留旋律与笔迹' : '允许修改旋律，保留笔迹'}`, { plan });
  } catch (error) { return response('clarify', error.message); }
}
