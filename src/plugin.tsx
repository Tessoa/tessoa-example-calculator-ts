// Example plugin: a calculator page.
//
// The user types a whole expression, such as 2 + 3 × (4 − 1), and = works it
// out: brackets first, then multiplication and division, then addition and
// subtraction. Brackets still open at = are closed there. The small line
// shows the expression; the large one the number being typed, or the
// result. An expression that cannot be worked out, such as 2 × ) or a
// division by zero, shows "Error".
//
// Every result also goes into a history, newest first; the page keeps the
// last 50 entries. The history is hidden at first, as in the calculators of
// Windows and phones: the keys have the whole page, and a quiet line above the
// number shows the last calculation. The history button at the end of that
// line, or Ctrl+H, opens the history beside the keys, in a split whose bar the
// user can drag. Each entry has two halves: a click on the expression puts it
// back on the small line to be changed and worked out again, a click on the
// result starts again from that number. "Clear history" empties it.
//
// Buttons and the keyboard do the same things: the page declares the keys
// it handles, and a click and a key press both become one action name. The
// copy button puts the shown number on the clipboard, the one permission
// the plugin declares. The state survives a restart, the history, whether it
// is open and where the user left the bar included: `save` hands it to
// tessoa, and `open` gets it back. A state saved by the previous version keeps
// its history, which opens closed; anything else starts afresh.
//
// The Rust twin in examples/calculator-rs draws the same tree for the same
// input; the tests compare the two node by node. Both work out an
// expression the same way (see Parser) and round results the same way (see
// formatNumber), so they show the same digits.

type Op = "+" | "-" | "*" | "/";

/**
 * One piece of an expression: an operator, a bracket, or a number as it was
 * typed or a result carried over (digits, at most one dot, and a minus in
 * front for a negative result).
 */
type Token = Op | "(" | ")" | string;

/** A worked-out expression: what = shows, and what the history keeps. */
interface Answer {
  /** The expression as shown, brackets closed. */
  expression: string;
  /** The result as shown, or "Error". */
  value: string;
}

interface Entry extends Answer {
  /**
   * Names the entry's button. Never reused, so that a key stays with its
   * entry when newer ones push it down.
   */
  id: number;
}

interface Calculator {
  /** The expression being typed. */
  tokens: Token[];
  /**
   * What = worked out, or the history entry clicked: shown until the user
   * types again.
   */
  answer: Answer | null;
  /** Newest first. */
  history: Entry[];
  nextId: number;
  /** Whether the history shows beside the keys. */
  historyOpen: boolean;
  /**
   * The share of the page the keys have while the history shows. Kept here
   * rather than left to tessoa, which forgets the bar of a split that leaves
   * the page.
   */
  ratio: number;
}

/** Keys the page handles while it has the focus. */
const KEYS = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "-", "*", "/", "(", ")", "=", "Enter", "Backspace",
  "Escape", "Delete", "Ctrl+c", "Meta+c", "Ctrl+h", "Meta+h",
];

/** Longest number the user can type, in characters. */
const MAX_DIGITS = 16;

/** Entries the history keeps; the oldest go first. */
const MAX_HISTORY = 50;

/** The share of the page the keys have when the history first opens. */
const RATIO = 0.62;

const SYMBOLS: Record<Op, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" };

function isOp(t: Token | undefined): t is Op {
  return t !== undefined && t in SYMBOLS;
}

/** Digits with at most one dot, and an optional minus in front. */
function isNumber(t: Token | undefined): boolean {
  return t !== undefined && /^-?(?=.*[0-9])[0-9]*\.?[0-9]*$/.test(t);
}

function initial(): Calculator {
  return { tokens: [], answer: null, history: [], nextId: 1, historyOpen: false, ratio: RATIO };
}

function isAnswer(a: unknown): a is Answer {
  const x = a as Partial<Answer> | null | undefined;
  return !!x && typeof x.expression === "string" && typeof x.value === "string";
}

/**
 * A saved state, when it has the shape this version saves or the previous
 * one did (without historyOpen and ratio, so the history opens closed);
 * otherwise a fresh one.
 */
function restore(state: unknown): Calculator {
  const s = state as Partial<Calculator> | null | undefined;
  if (
    s &&
    Array.isArray(s.tokens) &&
    s.tokens.every((t) => typeof t === "string" && (isOp(t) || t === "(" || t === ")" || isNumber(t))) &&
    (s.answer === null || isAnswer(s.answer)) &&
    Array.isArray(s.history) &&
    s.history.every((e) => isAnswer(e) && Number.isInteger(e.id)) &&
    Number.isInteger(s.nextId) &&
    (s.historyOpen === undefined || typeof s.historyOpen === "boolean") &&
    (s.ratio === undefined || (typeof s.ratio === "number" && s.ratio > 0 && s.ratio < 1))
  ) {
    return {
      tokens: s.tokens,
      answer: s.answer && { expression: s.answer.expression, value: s.answer.value },
      history: s.history.map((e) => ({ id: e.id, expression: e.expression, value: e.value })),
      nextId: s.nextId as number,
      historyOpen: s.historyOpen ?? false,
      ratio: s.ratio ?? RATIO,
    };
  }
  return initial();
}

function apply(op: Op, a: number, b: number): number {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
  }
}

/**
 * Works an expression out. A recursive descent parser: one method for each
 * level of precedence, each calling the level that binds tighter for its
 * operands.
 *
 *   expression = term { ("+" | "−") term }
 *   term       = factor { ("×" | "÷") factor }
 *   factor     = "−" factor | number | "(" expression ")"
 */
class Parser {
  private pos = 0;

  private constructor(private readonly tokens: Token[]) {}

  /** The value of the expression, or null when it cannot be read. */
  static evaluate(tokens: Token[]): number | null {
    const parser = new Parser(tokens);
    const value = parser.expression();
    // Anything left over, such as a ")" that closes nothing, is an error.
    return value !== null && parser.pos === tokens.length ? value : null;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    const token = this.peek();
    if (token !== undefined) this.pos++;
    return token;
  }

  private expression(): number | null {
    let value = this.term();
    for (let op = this.peek(); value !== null && (op === "+" || op === "-"); op = this.peek()) {
      this.pos++;
      const right = this.term();
      value = right === null ? null : apply(op, value, right);
    }
    return value;
  }

  private term(): number | null {
    let value = this.factor();
    for (let op = this.peek(); value !== null && (op === "*" || op === "/"); op = this.peek()) {
      this.pos++;
      const right = this.factor();
      value = right === null ? null : apply(op, value, right);
    }
    return value;
  }

  private factor(): number | null {
    const token = this.next();
    if (token === "-") {
      const value = this.factor();
      return value === null ? null : -value;
    }
    if (isNumber(token)) return Number(token);
    if (token === "(") {
      const value = this.expression();
      return value !== null && this.next() === ")" ? value : null;
    }
    return null;
  }
}

/**
 * Whether the operator at i is a sign in front of what follows rather than
 * a subtraction: it starts the expression, or follows another operator or
 * an opening bracket.
 */
function isSign(tokens: Token[], i: number): boolean {
  return isOp(tokens[i]) && (i === 0 || isOp(tokens[i - 1]) || tokens[i - 1] === "(");
}

/** The expression as the page shows it: 2 + 3 × (4 − 1), 2 × −3. */
function showExpression(tokens: Token[]): string {
  let out = "";
  tokens.forEach((token, i) => {
    const glued = i === 0 || tokens[i - 1] === "(" || token === ")" || isSign(tokens, i - 1);
    if (!glued) out += " ";
    out += isOp(token) ? SYMBOLS[token] : token;
  });
  return out;
}

/**
 * The tokens of an expression as showExpression wrote it, or null for
 * anything it does not write. The two minus signs tell a number from an
 * operator: a negative result carried over starts with a hyphen, -6; the
 * operator is the sign −.
 */
function readExpression(text: string): Token[] | null {
  const ops: Record<string, Op> = { "+": "+", "−": "-", "×": "*", "÷": "/" };
  const tokens: Token[] = [];
  for (const piece of text.match(/[-.0-9][.0-9]*|\S/g) ?? []) {
    if (piece === "(" || piece === ")") tokens.push(piece);
    else if (piece in ops) tokens.push(ops[piece]);
    else if (isNumber(piece)) tokens.push(piece);
    else return null;
  }
  return tokens;
}

/**
 * A result as the display shows it: rounded to ten decimals, without
 * trailing zeros, "Error" when it is not a number or too large. The rounding
 * is done by hand so that TypeScript and Rust print the same digits: both
 * round the same doubles in the same way, and the fixed-point formatting of
 * the rounded value is then exact in both.
 */
function formatNumber(x: number): string {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) return "Error";
  const r = Math.round(Math.abs(x) * 1e10) / 1e10;
  let s = (x < 0 ? -r : r).toFixed(10);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** The action of a declared key, named like the button that does the same. */
function keyAction(key: string): string | undefined {
  if (/^[0-9]$/.test(key)) return `k${key}`;
  const actions: Record<string, string> = {
    ".": "dot",
    "+": "add",
    "-": "sub",
    "*": "mul",
    "/": "div",
    "(": "open",
    ")": "close",
    "=": "eq",
    Enter: "eq",
    Backspace: "back",
    Escape: "clear",
    Delete: "clear",
    "Ctrl+c": "copy",
    "Meta+c": "copy",
    "Ctrl+h": "toggle-history",
    "Meta+h": "toggle-history",
  };
  return actions[key];
}

/** The large line: the result, or the last number typed. */
function display(c: Calculator): string {
  if (c.answer) return c.answer.value;
  for (let i = c.tokens.length - 1; i >= 0; i--) {
    if (isNumber(c.tokens[i])) return c.tokens[i];
  }
  return "0";
}

/** The small line: the expression being typed, or the one worked out. */
function expression(c: Calculator): string {
  return c.answer ? `${c.answer.expression} =` : showExpression(c.tokens);
}

/** A number or a bracket typed after an answer starts a new expression. */
function startOverAfterAnswer(c: Calculator): void {
  if (c.answer) {
    c.answer = null;
    c.tokens = [];
  }
}

/**
 * A number or an opening bracket right after a closing bracket means a
 * multiplication: (1 + 2)4 is (1 + 2) × 4. The × is put in, so that the
 * expression shows what is worked out.
 */
function multiplyAfterClose(c: Calculator): void {
  if (c.tokens[c.tokens.length - 1] === ")") c.tokens.push("*");
}

function digits(n: string): number {
  return n.replace(/^-/, "").length;
}

function digit(c: Calculator, d: string): void {
  startOverAfterAnswer(c);
  multiplyAfterClose(c);
  const last = c.tokens.length - 1;
  const n = c.tokens[last];
  if (!isNumber(n)) c.tokens.push(d);
  else if (n === "0") c.tokens[last] = d;
  else if (digits(n) < MAX_DIGITS) c.tokens[last] = n + d;
}

function dot(c: Calculator): void {
  startOverAfterAnswer(c);
  multiplyAfterClose(c);
  const last = c.tokens.length - 1;
  const n = c.tokens[last];
  if (!isNumber(n)) c.tokens.push("0.");
  else if (!n.includes(".") && digits(n) < MAX_DIGITS) c.tokens[last] = n + ".";
}

/** An opening bracket right after a number multiplies too: 2(3) is 2 × (3). */
function open(c: Calculator): void {
  startOverAfterAnswer(c);
  multiplyAfterClose(c);
  if (isNumber(c.tokens[c.tokens.length - 1])) c.tokens.push("*");
  c.tokens.push("(");
}

function close(c: Calculator): void {
  startOverAfterAnswer(c);
  c.tokens.push(")");
}

/** An operator after an answer goes on from its result. */
function operator(c: Calculator, op: Op): void {
  if (c.answer) {
    if (c.answer.value === "Error") return;
    c.tokens = [c.answer.value];
    c.answer = null;
  }
  c.tokens.push(op);
}

function equals(c: Calculator): void {
  if (c.answer || c.tokens.length === 0) return;
  const opened = c.tokens.filter((t) => t === "(").length;
  const closed = c.tokens.filter((t) => t === ")").length;
  for (let i = closed; i < opened; i++) c.tokens.push(")");
  const result = Parser.evaluate(c.tokens);
  const answer: Answer = {
    expression: showExpression(c.tokens),
    value: result === null ? "Error" : formatNumber(result),
  };
  // A lone number is its own result, not worth an entry.
  if (answer.value !== "Error" && c.tokens.length > 1) {
    c.history.unshift({ id: c.nextId, ...answer });
    c.history.length = Math.min(c.history.length, MAX_HISTORY);
    c.nextId++;
  }
  c.tokens = [];
  c.answer = answer;
}

function back(c: Calculator): void {
  if (c.answer || c.tokens.length === 0) return;
  const last = c.tokens.length - 1;
  const n = c.tokens[last];
  if (isNumber(n)) {
    const shorter = n.slice(0, -1);
    if (shorter === "" || shorter === "-") c.tokens.pop();
    else c.tokens[last] = shorter;
  } else {
    c.tokens.pop();
  }
}

/** The quiet line above the number: the last calculation, or nothing. */
function last(c: Calculator): string {
  const e = c.history[0];
  return e ? `${e.expression} = ${e.value}` : "";
}

/**
 * Puts the expression of a history entry back on the small line, to be
 * changed and worked out again.
 */
function recallExpression(c: Calculator, entry: Entry): void {
  const tokens = readExpression(entry.expression);
  if (!tokens) throw new Error(`history entry ${entry.id} cannot be read back`);
  c.tokens = tokens;
  c.answer = null;
}

/** Starts again from the result of a history entry. */
function recallValue(c: Calculator, entry: Entry): void {
  c.answer = { expression: entry.expression, value: entry.value };
  c.tokens = [];
}

/** Do what the button with this key does. */
function press(c: Calculator, action: string): void {
  switch (action) {
    case "clear":
      c.tokens = [];
      c.answer = null;
      return;
    case "clear-history":
      c.history = [];
      return;
    case "toggle-history":
      c.historyOpen = !c.historyOpen;
      return;
    case "back":
      return back(c);
    case "dot":
      return dot(c);
    case "open":
      return open(c);
    case "close":
      return close(c);
    case "add":
      return operator(c, "+");
    case "sub":
      return operator(c, "-");
    case "mul":
      return operator(c, "*");
    case "div":
      return operator(c, "/");
    case "eq":
      return equals(c);
    case "copy":
      tessoa.clipboard.writeText(display(c));
      return;
  }
  if (/^k[0-9]$/.test(action)) return digit(c, action.slice(1));
  throw new Error(`no action named ${JSON.stringify(action)}`);
}

tessoa.pages.define<Calculator>("calculator", {
  keys: KEYS,
  open: ({ state }) => restore(state),
  save: (c) => c,
  onKey: (c, k) => {
    const action = keyAction(k.key);
    if (action) press(c, action);
  },
  render: (c) => {
    const key = (k: string, label: string, kind?: tessoa.pages.ButtonKind) => (
      <button key={k} grow kind={kind} onClick={() => press(c, k)}>
        {label}
      </button>
    );
    const calculator = (
      <column pad="m" gap="s">
        <row gap="s" align="center">
          <text key="last" size="caption" tone="dim" grow>
            {last(c)}
          </text>
          <icon-button
            key="toggle-history"
            icon="menu"
            label={c.historyOpen ? "Hide history" : "Show history"}
            kind={c.historyOpen ? "normal" : "quiet"}
            onClick={() => press(c, "toggle-history")}
          />
        </row>
        <text key="expression" size="caption" tone="dim" align="end">
          {expression(c)}
        </text>
        <row gap="s" align="center">
          <icon-button key="copy" icon="copy" label="Copy" onClick={() => press(c, "copy")} />
          <text key="display" size="display" align="end" grow>
            {display(c)}
          </text>
        </row>
        <row gap="s">
          {key("clear", "C")}
          {key("open", "(")}
          {key("close", ")")}
          {key("div", "÷")}
        </row>
        <row gap="s">
          {key("k7", "7")}
          {key("k8", "8")}
          {key("k9", "9")}
          {key("mul", "×")}
        </row>
        <row gap="s">
          {key("k4", "4")}
          {key("k5", "5")}
          {key("k6", "6")}
          {key("sub", "−")}
        </row>
        <row gap="s">
          {key("k1", "1")}
          {key("k2", "2")}
          {key("k3", "3")}
          {key("add", "+")}
        </row>
        <row gap="s">
          {key("k0", "0")}
          {key("dot", ".")}
          {key("back", "⌫")}
          {key("eq", "=", "primary")}
        </row>
      </column>
    );
    if (!c.historyOpen) return calculator;
    return (
      <column>
        <split
          key="panes"
          ratio={c.ratio}
          grow
          onChange={(ratio) => {
            // tessoa keeps the bar within the page; a ratio beyond it would
            // make the saved state unreadable, so it is not taken.
            if (ratio > 0 && ratio < 1) c.ratio = ratio;
          }}
        >
          {calculator}
          <column pad="m" gap="s">
            <row gap="s" align="center">
              <text size="caption" tone="dim" grow>
                History
              </text>
              <button
                key="clear-history"
                kind="quiet"
                disabled={c.history.length === 0}
                onClick={() => press(c, "clear-history")}
              >
                Clear history
              </button>
            </row>
            <column key="history" gap="xs" scroll grow>
              {c.history.length === 0 ? (
                <text key="history-empty" tone="dim" align="center">
                  No calculations yet
                </text>
              ) : (
                c.history.map((e) => (
                  <row key={`h${e.id}`} gap="s" justify="between" align="center">
                    <button
                      key={`h${e.id}-expr`}
                      kind="quiet"
                      tooltip="Use this expression"
                      onClick={() => recallExpression(c, e)}
                    >
                      {e.expression}
                    </button>
                    <button
                      key={`h${e.id}-value`}
                      kind="quiet"
                      tooltip="Use this result"
                      onClick={() => recallValue(c, e)}
                    >
                      {`= ${e.value}`}
                    </button>
                  </row>
                ))
              )}
            </column>
          </column>
        </split>
      </column>
    );
  },
});
