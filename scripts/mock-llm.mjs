// Minimal OpenAI-compatible mock: echoes a verdict per test_key it sees in the payload.
import { createServer } from "node:http";
const PORT = process.argv[2] || 8899;
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body);
    const user = payload.messages.find((m) => m.role === "user").content;
    const keys = [...user.matchAll(/### test_key: (\S+)/g)].map((m) => m[1]);
    const verdicts = keys.map((k, i) => ({
      test_key: k,
      kind: i === 0 ? "flake_likely" : "unknown",
      confidence: i === 0 ? "medium" : "low",
      one_line_reason:
        i === 0
          ? "assertion on a value that depends on map iteration order"
          : "no changed file is referenced and the message is generic",
      likely_cause: i === 0 ? "test asserts an unordered collection as if ordered" : "",
      suspect_location: null,
      suggested_next_step:
        i === 0 ? "sort the collection before asserting" : "add more history before deciding",
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
        usage: { prompt_tokens: 1400, completion_tokens: 120 },
      }),
    );
  });
}).listen(PORT, () => console.error(`mock LLM on :${PORT}`));
