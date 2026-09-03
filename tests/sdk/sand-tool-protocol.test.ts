import { expect, test } from "vitest";
import {
  parseSandToolCall,
  partialSuffixLength,
  renderSandToolProtocol,
  renderSandToolResults,
  repairJsonControlChars,
  SAND_TOOL_CALL_CLOSE,
  SAND_TOOL_CALL_OPEN,
  SandToolCallScanner,
} from "../../src/sdk/sand-tool-protocol.js";

const names = new Set(["Bash", "Read"]);

/** Feed text to the scanner in chunks of `size` characters and collect the visible output. */
function scan(text: string, size: number): { visible: string; scanner: SandToolCallScanner } {
  const scanner = new SandToolCallScanner(names);
  let visible = "";
  for (let offset = 0; offset < text.length; offset += size) {
    visible += scanner.push(text.slice(offset, offset + size));
  }
  visible += scanner.end();
  return { visible, scanner };
}

test("partialSuffixLength finds the longest tag prefix held back at a chunk boundary", () => {
  expect(partialSuffixLength("hello <sand:to", SAND_TOOL_CALL_OPEN)).toBe(8);
  expect(partialSuffixLength("hello <", SAND_TOOL_CALL_OPEN)).toBe(1);
  expect(partialSuffixLength("hello", SAND_TOOL_CALL_OPEN)).toBe(0);
  expect(partialSuffixLength("x</sand:tool_call", SAND_TOOL_CALL_CLOSE)).toBe(SAND_TOOL_CALL_CLOSE.length - 1);
  // A complete tag is not a proper prefix and must not be held back.
  expect(partialSuffixLength(SAND_TOOL_CALL_OPEN, SAND_TOOL_CALL_OPEN)).toBe(0);
});

test("scanner separates prose from tool calls regardless of chunking", () => {
  const text = [
    "I will check memory first.",
    SAND_TOOL_CALL_OPEN,
    '{"name": "Bash", "input": {"command": "free -h"}}',
    SAND_TOOL_CALL_CLOSE,
    "\n",
    SAND_TOOL_CALL_OPEN,
    '\n{"name": "Read", "input": {"file_path": "/tmp/MEMORY.md"}}\n',
    SAND_TOOL_CALL_CLOSE,
    "\n",
  ].join("");
  for (const size of [1, 3, 7, 16, 64, text.length]) {
    const { visible, scanner } = scan(text, size);
    expect(visible, `chunk size ${size}`).toBe("I will check memory first.");
    expect(scanner.calls).toEqual([
      { ok: true, name: "Bash", input: { command: "free -h" }, raw: '{"name": "Bash", "input": {"command": "free -h"}}' },
      {
        ok: true,
        name: "Read",
        input: { file_path: "/tmp/MEMORY.md" },
        raw: '\n{"name": "Read", "input": {"file_path": "/tmp/MEMORY.md"}}\n',
      },
    ]);
    expect(scanner.raw).toBe(text);
  }
});

test("scanner passes plain prose through untouched, including angle brackets", () => {
  const text = "Compare a < b and <div> tags; nothing to call here.";
  const { visible, scanner } = scan(text, 5);
  expect(visible).toBe(text);
  expect(scanner.calls).toEqual([]);
});

test("scanner accepts an unterminated trailing block that parses, and surfaces one that does not", () => {
  const ok = scan(`${SAND_TOOL_CALL_OPEN}{"name":"Bash","input":{"command":"ls"}}`, 4);
  expect(ok.visible).toBe("");
  expect(ok.scanner.calls).toEqual([{ ok: true, name: "Bash", input: { command: "ls" }, raw: '{"name":"Bash","input":{"command":"ls"}}' }]);

  const broken = scan(`${SAND_TOOL_CALL_OPEN}{"name":"Bash","input":`, 4);
  expect(broken.visible).toBe(`${SAND_TOOL_CALL_OPEN}{"name":"Bash","input":`);
  expect(broken.scanner.calls).toEqual([]);
});

test("scanner reports malformed blocks without dropping them", () => {
  const { visible, scanner } = scan(`${SAND_TOOL_CALL_OPEN}{"name":"Nope","input":{}}${SAND_TOOL_CALL_CLOSE}`, 9);
  expect(visible).toBe("");
  expect(scanner.calls).toHaveLength(1);
  expect(scanner.calls[0]).toMatchObject({ ok: false, error: expect.stringContaining('unknown tool "Nope"') });
});

test("parseSandToolCall tolerates code fences, literal newlines in strings, and argument aliases", () => {
  expect(parseSandToolCall('```json\n{"name":"Bash","input":{"command":"echo hi"}}\n```', names)).toMatchObject({
    ok: true,
    name: "Bash",
    input: { command: "echo hi" },
  });
  expect(parseSandToolCall('{"name":"Bash","input":{"command":"printf a\nb"}}', names)).toMatchObject({
    ok: true,
    input: { command: "printf a\nb" },
  });
  expect(parseSandToolCall('{"name":"Read","arguments":{"file_path":"x"}}', names)).toMatchObject({
    ok: true,
    input: { file_path: "x" },
  });
  expect(parseSandToolCall('{"name":"Read"}', names)).toMatchObject({ ok: true, input: {} });
  expect(parseSandToolCall("", names)).toMatchObject({ ok: false });
  expect(parseSandToolCall("not json", names)).toMatchObject({ ok: false });
  expect(parseSandToolCall('{"input":{}}', names)).toMatchObject({ ok: false, error: expect.stringContaining("name") });
  expect(parseSandToolCall('{"name":"Bash","input":[1]}', names)).toMatchObject({ ok: false, error: expect.stringContaining("object") });
});

test("repairJsonControlChars only touches control characters inside strings", () => {
  expect(repairJsonControlChars('{"a":"x\ny",\n"b":"t\tab"}')).toBe('{"a":"x\\ny",\n"b":"t\\tab"}');
  expect(repairJsonControlChars('{"a":"quote \\" \n"}')).toBe('{"a":"quote \\" \\n"}');
});

test("protocol prompt lists every tool with its schema and the exact tags", () => {
  const prompt = renderSandToolProtocol({
    Bash: {
      description: "Run a shell command",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      execute: () => "",
    },
    Read: { execute: () => "" },
  });
  expect(prompt).toContain(SAND_TOOL_CALL_OPEN);
  expect(prompt).toContain(SAND_TOOL_CALL_CLOSE);
  expect(prompt).toContain('"name": "Bash"');
  expect(prompt).toContain("Run a shell command");
  expect(prompt).toContain('"name": "Read"');
  expect(prompt).toMatch(/never pretend to have run a tool/);
});

test("tool results render as tagged blocks with escaped attributes and error feedback", () => {
  const text = renderSandToolResults(
    [
      { id: "toolu_1", name: "Bash", result: "total 1" },
      { id: 'weird"id', name: "Read", result: { content: [{ type: "text", text: "line" }, { type: "image", data: "..." }], isError: true } },
      { id: "toolu_3", name: "Read", result: { content: [], structuredContent: { ok: true } } },
    ],
    [{ error: "unknown tool \"Nope\"", raw: '{"name":"Nope"}' }],
  );
  expect(text).toContain('<sand:tool_result id="toolu_1" name="Bash" is_error="false">\ntotal 1\n</sand:tool_result>');
  expect(text).toContain('id="weird&quot;id" name="Read" is_error="true"');
  expect(text).toContain("[image omitted");
  expect(text).toContain('{"ok":true}');
  expect(text).toContain('id="malformed-1" name="" is_error="true"');
  expect(text).toContain('unknown tool "Nope"');
});
