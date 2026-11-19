import js from "@eslint/js"
import tseslint from "typescript-eslint"

// The egress rule: only src/egress.ts opens connections, only src/http.ts
// listens, and only src/cli.ts starts a process (the Claude Code CLI and
// git; see README.md, "Where it connects"). This is a code convention
// checked by lint and by test/egress.test.ts, not a sandbox.
const NETWORK = [
  "https",
  "http",
  "http2",
  "net",
  "tls",
  "dns",
  "dgram",
  "child_process",
  "worker_threads",
  "cluster",
  "inspector",
  "undici",
]

function restrictedImports(allowed = []) {
  const paths = []
  for (const name of NETWORK.filter((module) => !allowed.includes(module))) {
    const message =
      name === "http"
        ? "Only src/http.ts serves, and nothing dials over HTTP."
        : name === "child_process"
          ? "Only src/cli.ts starts a process."
          : `Only src/egress.ts reaches the network: no ${name} here.`
    paths.push({ name, message })
    if (name !== "undici") paths.push({ name: `node:${name}`, message })
  }
  for (const name of ["module", "node:module"]) {
    paths.push({
      name,
      importNames: ["createRequire"],
      message: "No createRequire: it loads modules past the import rules.",
    })
  }
  return ["error", { paths }]
}

const NETWORK_SOURCE = `^(node:)?(${NETWORK.join("|")})$`

const restrictedSyntax = [
  "error",
  {
    selector: `ImportExpression[source.type='Literal'][source.value=/${NETWORK_SOURCE}/]`,
    message: "Only src/egress.ts reaches the network.",
  },
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: "No dynamic import of a computed name.",
  },
  {
    selector: "CallExpression[callee.name='require']",
    message: "No require: ES modules only.",
  },
]

const restrictedProperties = [
  "error",
  { object: "globalThis", property: "fetch", message: "No fetch." },
  { object: "global", property: "fetch", message: "No fetch." },
  { object: "globalThis", property: "WebSocket", message: "No WebSocket." },
  { object: "process", property: "binding", message: "No process.binding." },
  { object: "process", property: "dlopen", message: "No process.dlopen." },
]

const restrictedGlobals = [
  "error",
  { name: "fetch", message: "Only src/egress.ts dials out." },
  { name: "WebSocket", message: "Only src/egress.ts dials out." },
  { name: "EventSource", message: "Only src/egress.ts dials out." },
  { name: "XMLHttpRequest", message: "Only src/egress.ts dials out." },
]

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": restrictedImports(),
      "no-restricted-syntax": restrictedSyntax,
      "no-restricted-properties": restrictedProperties,
      "no-restricted-globals": restrictedGlobals,
    },
  },
  {
    files: ["src/egress.ts"],
    rules: { "no-restricted-imports": restrictedImports(["https"]) },
  },
  {
    // The Claude Code CLI and git, with an argument list, never a shell.
    files: ["src/cli.ts"],
    rules: { "no-restricted-imports": restrictedImports(["child_process"]) },
  },
  {
    // The MCP side: a server it listens with, never a request it makes.
    files: ["src/http.ts"],
    rules: { "no-restricted-imports": restrictedImports(["http"]) },
  },
  {
    files: [
      "test/**/*.ts",
      "test/**/*.mjs",
      "scripts/**/*.ts",
      "*.config.ts",
      "eslint.config.js",
    ],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
      "no-restricted-properties": "off",
    },
  },
  {
    // The fake CLI is plain Node, run as a child process by the tests.
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
)
