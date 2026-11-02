import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMessage,
  createChat,
  restoreState,
  requestMessages,
  exportConversation,
} from "../modules/chat-store.mjs";

const comparison =
  "| Approach | Risk | Notes |\n| :--- | ---: | :---: |\n| **Patient** | 1% | `Wait` |\n| Fast | 2% | More noise |";

test("Markdown tables render semantic, aligned headers and cells inside a keyboard-scrollable region", () => {
  const html = formatMessage(comparison);
  assert.match(
    html,
    /class="message-table-scroll" role="region"[^>]+tabindex="0"/,
  );
  assert.match(
    html,
    /<table><thead><tr><th scope="col" class="align-left">Approach<\/th>/,
  );
  assert.match(html, /<th scope="col" class="align-right">Risk<\/th>/);
  assert.match(html, /<th scope="col" class="align-center">Notes<\/th>/);
  assert.match(html, /<td class="align-left"><strong>Patient<\/strong><\/td>/);
  assert.match(html, /<td class="align-right">1%<\/td>/);
  assert.match(html, /<td class="align-center"><code>Wait<\/code><\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.doesNotMatch(html, /\| :---|\| Fast/);
});

test("tables work without edge pipes, with CRLF, and adjacent to headings, prose and lists", () => {
  const html = formatMessage(
    "## Comparison\r\nHypothetical only.\r\nName | Value\r\n--- | ---:\r\nA | 10\r\nB | 20\r\nNext steps:\r\n- First\r\n- Second",
  );
  assert.match(html, /^<h3>Comparison<\/h3><p>Hypothetical only\.<\/p><div/);
  assert.match(html, /<td class="align-right">20<\/td>/);
  assert.match(
    html,
    /<\/table><\/div><p>Next steps:<\/p><ul><li>First<\/li><li>Second<\/li><\/ul>$/,
  );
});

test("literal escaped pipes and pipes in inline code stay inside their cells", () => {
  const html = formatMessage(
    "| Expression | Meaning |\n| --- | --- |\n| `a | b` | a \\| b |\n| ``x|y`` | \\| |\n| **bold** | `**not bold**` |",
  );
  assert.equal((html.match(/<td /g) || []).length, 6);
  assert.match(html, /<code>a \| b<\/code>/);
  assert.match(html, /<code>x\|y<\/code>/);
  assert.match(html, /<td class="align-left">a \| b<\/td>/);
  assert.match(html, /<code>\*\*not bold\*\*<\/code>/);
});

test("empty and partial table cells are padded without dropping the table", () => {
  const html = formatMessage(
    "| A | B | C |\n| --- | --- | --- |\n| one | | three |\n| unfinished\n| extra | cells | here | ignored |",
  );
  assert.equal((html.match(/<td /g) || []).length, 9);
  assert.match(
    html,
    /<tr><td class="align-left">unfinished<\/td><td class="align-left"><\/td><td class="align-left"><\/td><\/tr>/,
  );
  assert.doesNotMatch(html, /ignored/);
});

test("raw HTML, links and event attributes in table headers/cells cannot execute", () => {
  const html = formatMessage(
    '| <img src=x onerror="alert(1)"> | <script>bad()</script> |\n| --- | --- |\n| [click](javascript:alert(1)) | `<svg onload=bad()>` |\n| &lt;script&gt; | **<iframe src=x>** |',
  );
  assert.doesNotMatch(html, /<(?:img|script|svg|iframe|a)\b/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<code>&lt;svg onload=bad\(\)&gt;<\/code>/);
  assert.match(html, /&amp;lt;script&amp;gt;/);
});

test("fenced code remains escaped code, not a table, including an unfinished code fence", () => {
  for (const closing of ["\n```", ""]) {
    const html = formatMessage("```markdown\n" + comparison + closing);
    assert.match(html, /^<pre><code>\| Approach/);
    assert.doesNotMatch(html, /<table>|<strong>/);
  }
});

test("ordinary pipe text and invalid/mismatched delimiter rows are not mistaken for tables", () => {
  for (const text of [
    "a | b",
    "A | B\nnot | a delimiter",
    "A | B\n--- | --- | ---",
    "| A | B |\n| --- |\n| x | y |",
  ])
    assert.doesNotMatch(formatMessage(text), /<table>/);
});

test("multiple tables and every incomplete streaming prefix produce balanced, safe markup", () => {
  const text =
    "## Details\n" +
    comparison +
    "\n\nOther table:\n| ₹ | 🪙 |\n| --- | --- |\n| 12 | 金 |\n\nDone.";
  const html = formatMessage(text);
  assert.equal((html.match(/<table>/g) || []).length, 2);
  assert.match(html, /<td class="align-left">金<\/td>/);
  for (let length = 0; length <= text.length; length++) {
    const prefix = formatMessage(text.slice(0, length));
    for (const tag of ["table", "thead", "tbody", "tr", "th", "td", "pre"])
      assert.equal(
        (prefix.match(new RegExp(`<${tag}(?: |>)`, "g")) || []).length,
        (prefix.match(new RegExp(`</${tag}>`, "g")) || []).length,
        `${tag} at prefix ${length}`,
      );
  }
});

test("partial replies remain labeled after reload/export and never become provider context", () => {
  const chat = createChat();
  chat.messages = [
    { id: "q", role: "user", content: "Compare these" },
    { id: "a", role: "assistant", content: comparison, incomplete: true },
    { id: "q2", role: "user", content: "Try again" },
  ];
  const restored = restoreState({ conversations: [chat], activeId: chat.id })
    .conversations[0];
  assert.equal(restored.messages[1].incomplete, true);
  assert.equal(restored.messages[1].content, comparison);
  assert.match(
    exportConversation(restored),
    /Partial response — stopped or interrupted/,
  );
  assert.deepEqual(requestMessages(restored.messages), [
    { role: "user", content: "Compare these" },
    { role: "user", content: "Try again" },
  ]);
  assert.match(formatMessage(restored.messages[1].content), /<table>/);
});
