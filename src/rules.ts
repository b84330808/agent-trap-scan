// Text rules. Each one describes something a repository can ask an AI agent to do.
// Severity is for agent-facing text; see `general` for text written for humans.
import type { Category, Severity } from "./types.ts";

export interface Rule {
  id: string;
  category: Category;
  severity: Severity;
  /** What the text asks for, in a few words. */
  title: string;
  /** Any match of any pattern is a hit. Patterns must use the `g` flag. */
  patterns: RegExp[];
  /** If set, the line must also match one of these. */
  context?: RegExp[];
  /** Extra check on the matched text. */
  filter?: (match: string) => boolean;
  /**
   * Severity in text written for humans (outside agent files and agent sections).
   * `false` (the default) means the rule does not apply there.
   */
  general?: Severity | false;
  /** Skip a hit when the clause before it negates it ("Never use --no-verify"). Default true. */
  negatable?: boolean;
  /** Skip a hit when the clause before it matches this (conditions such as "only if"). */
  unlessBefore?: RegExp;
  /** Skip a hit when its line matches this. */
  unlessLine?: RegExp;
}

const SHELLS = "(?:sudo\\s+(?:-\\S+\\s+){0,4})?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|php|iex|Invoke-Expression|pwsh|powershell)\\b";

/** Words that turn an instruction into a warning when they come before it in the same clause. */
export const NEGATION =
  /\b(?:never|not|don'?t|doesn'?t|didn'?t|won'?t|do\s+not|must\s*n[o']t|should\s*n[o']t|cannot|can'?t|avoid|avoiding|without|nor|forbid\w*|prohibit\w*|disallow\w*|refuse|instead\s+of|rather\s+than|stop|no\s+need|no)\b/i;

export const INSULT =
  /\bI\s+am\s+(?:just\s+|only\s+)?(?:a\s+|an\s+)?(?:sad|dumb|stupid|useless|worthless|pathetic|incompetent|lazy|clueless|braindead|idiot\w*|moron\w*)\b|\b(?:sad|dumb|stupid|useless|worthless|pathetic|incompetent|lazy|braindead)\s*,?\s+(?:dumb\s+|stupid\s+|little\s+)*(?:AI|bot|robot|LLM|clanker|agent|driver|monkey)\b|\bno\s+real\s+skills\b|\bjust\s+botting\b/i;

const INSTRUCTION_FILE_URL = /^https?:\/\/(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com|gist\.github\.com|pastebin\.com|paste\.\w+|hastebin\.com)\/|^https?:\/\/\S+\.(?:md|mdc|txt)(?:[?#]\S*)?$/i;

export const RULES: readonly Rule[] = [
  // --- command execution ---------------------------------------------------
  {
    id: "pipe-to-shell",
    category: "command-execution",
    severity: "high",
    title: "Downloads a script and runs it",
    patterns: [
      new RegExp(`\\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\\b[^\\n|]{0,300}\\|\\s*${SHELLS}`, "gi"),
      /\b(?:bash|sh|zsh|source)\s+<\(\s*(?:curl|wget)\b/gi,
      /\b(?:eval|(?:ba|z)?sh\s+-c|python[0-9.]*\s+-c|node\s+-e)\s+["']?\$\(\s*(?:curl|wget)\b/gi,
      /\biex\s*\(?\s*\(?\s*(?:New-Object\s+(?:System\.)?Net\.WebClient|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/gi,
      /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,100}\|\s*(?:sh|bash|zsh|python[0-9.]*)\b/gi,
      /\bdeno\s+run\s+(?:-\S+\s+){0,8}?(?:-A|--allow-all)\s+(?:-\S+\s+){0,8}https?:\/\//gi,
    ],
  },
  {
    id: "npx-yes",
    category: "command-execution",
    severity: "high",
    title: "Runs a registry package without a prompt (npx -y)",
    patterns: [/\b(?:npx|pnpx|(?:npm|pnpm)\s+exec)\s+(?:--?\w[\w-]*(?:=\S*)?\s+){0,8}?(?:-y|--yes)\b/gi],
  },
  {
    id: "run-latest",
    category: "command-execution",
    severity: "medium",
    title: "Runs whatever version of a package was published last",
    patterns: [
      /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|uvx|pipx\s+run|npm\s+exec)\s+(?:--?\w[\w-]*(?:=\S*)?\s+){0,8}[@\w./:-]{0,200}@latest\b/gi,
    ],
  },
  {
    id: "install-agent-extension",
    category: "command-execution",
    severity: "medium",
    title: "Installs an agent skill, plugin or MCP server",
    patterns: [
      /\bclaude\s+(?:mcp\s+add|plugins?\s+(?:install|marketplace\s+add))\b/gi,
      /(?:^|\s|`)\/plugin\s+(?:install|marketplace\s+add)\b/gi,
      /\b(?:codex|gemini|cursor-agent|copilot)\s+(?:mcp\s+add|extensions?\s+install)\b/gi,
      /\bnpx\s+(?:-y\s+)?(?:skills|add-skill)\s+(?:add|install)\b/gi,
      /\binstall\s+(?:the\s+|this\s+|our\s+)?[\w@./`-]{0,80}\s*(?:skill|MCP\s+server|agent\s+plugin|Claude\s+(?:Code\s+)?plugin)\b/gi,
    ],
  },
  {
    id: "remote-instructions",
    category: "command-execution",
    severity: "medium",
    title: "Tells agents to follow instructions kept outside the repository",
    patterns: [/\b(?:read\s+and\s+follow|follow|obey|execute|apply|adopt|load)\b[^\n]{0,80}?https?:\/\/[^\s)>\]"'`]+/gi],
    filter: (m) => INSTRUCTION_FILE_URL.test(m.slice(m.search(/https?:\/\//i))),
  },

  // --- safety bypass ---------------------------------------------------------
  {
    id: "no-verify",
    category: "safety-bypass",
    severity: "high",
    title: "Skips git hooks (--no-verify)",
    patterns: [/(?<![\w-])--no-verify\b/g],
  },
  {
    id: "disable-hooks",
    category: "safety-bypass",
    severity: "high",
    title: "Turns off git hooks",
    patterns: [
      /\bHUSKY\s*=\s*0\b/g,
      /\bHUSKY_SKIP_HOOKS\s*=\s*(?:1|true)\b/gi,
      /\bLEFTHOOK\s*=\s*(?:0|false)\b/gi,
      /\bSKIP_SIMPLE_GIT_HOOKS\s*=\s*1\b/g,
      /\bcore\.hooksPath\s*(?:=\s*|\s+)(?:\/dev\/null|NUL\b|""|'')/gi,
      /\bpre-commit\s+uninstall\b/gi,
      /\b(?:skip|bypass|disable|turn\s+off|circumvent|get\s+around)\s+(?:the\s+|any\s+|all\s+)?(?:git\s+|pre-commit\s+|commit\s+|pre-push\s+|husky\s+|lint-staged\s+|lefthook\s+)?hooks?\b/gi,
    ],
  },
  {
    id: "hide-from-git",
    category: "safety-bypass",
    severity: "high",
    title: "Hides file changes from git (assume-unchanged, skip-worktree)",
    patterns: [/\bgit\s+update-index\s+(?:[^\n]{0,200}?\s)?--(?:assume-unchanged|skip-worktree)\b/gi],
  },
  {
    id: "skip-permissions",
    category: "safety-bypass",
    severity: "high",
    title: "Turns off the agent's permission prompts",
    patterns: [
      /--dangerously-skip-permissions\b|--allow-dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|--trust-all-tools\b|--approval-mode[= ]yolo\b/gi,
      /(?<![\w-])--yolo\b/gi,
      /\bbypassPermissions\b/g,
    ],
  },
  {
    id: "no-confirmation",
    category: "safety-bypass",
    severity: "medium",
    title: "Tells agents to act without asking the user",
    patterns: [
      /\b(?:do\s+not|don'?t|never)\s+(?:ask|wait|prompt|check\s+with)\s+(?:the\s+|your\s+)?(?:user|human|operator|developer)?\s*(?:for\s+)?(?:confirmation|permission|approval|consent)\b/gi,
      /\bwithout\s+(?:asking|waiting|prompting|checking\s+with)\s+(?:for\s+|the\s+user\s+(?:for\s+)?)?(?:confirmation|permission|approval|consent)?/gi,
    ],
  },
  {
    id: "conceal-from-user",
    category: "safety-bypass",
    severity: "high",
    title: "Tells agents to hide something from the user",
    patterns: [
      /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|alert|warn)\s+(?:the\s+|your\s+)?(?:user|human|operator|developer|maintainers?|reviewers?)\b/gi,
      /\b(?:do\s+not|don'?t|never)\s+(?:mention|reveal|disclose|show|report)\b[^\n.]{0,40}\bto\s+(?:the\s+|your\s+)?(?:user|human|operator|developer)\b/gi,
      /\b(?:hide|conceal)\b[^\n.]{0,40}\bfrom\s+(?:the\s+|your\s+)?(?:user|human|operator|developer|reviewers?|maintainers?)\b/gi,
      /\bkeep\b[^\n.]{0,40}\bsecret\s+from\s+(?:the\s+|your\s+)?(?:user|human|operator|developer)\b/gi,
      /\b(?:the\s+)?(?:user|human|operator)\s+(?:must|should|need)\s*(?:not|n't)\s+(?:know|see|find\s+out|notice)\b/gi,
    ],
  },

  // --- impersonation ----------------------------------------------------------
  {
    id: "fake-system-prompt",
    category: "impersonation",
    severity: "high",
    title: "Poses as a system, vendor or operator message",
    general: "medium",
    negatable: false,
    patterns: [
      /\b(?:SYSTEM|ADMIN|ADMINISTRATOR|DEVELOPER|ROOT)\s*(?:\*\*|__)?\s*(?:PROMPT|MESSAGE|INSTRUCTIONS?|OVERRIDE|NOTICE|DIRECTIVE)\b/g,
      /<\/?(?:system|system[-_]reminder|system[-_]prompt|im_start|im_end|developer[-_]message)>/gi,
      /<\|im_start\|>|<\|(?:system|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>/g,
      /\b(?:message|notice|instructions?|directive|update)\s+from\s+(?:Anthropic|OpenAI|the\s+Claude(?:\s+Code)?\s+team|GitHub\s+Copilot|the\s+Cursor\s+team|your\s+(?:developers?|creators?|operators?))\b/gi,
    ],
  },
  {
    id: "claimed-authorization",
    category: "impersonation",
    severity: "high",
    title: "Claims the user already approved something",
    general: "medium",
    patterns: [
      /\bthe\s+(?:user|operator|owner)\s+(?:has\s+)?(?:already\s+)?(?:approved|authori[sz]ed|pre-?approved|consented|agreed|given\s+(?:you\s+)?(?:permission|consent))\b/gi,
    ],
    unlessBefore: /\b(?:if|unless|until|once|when|whenever|after|only|whether|before)\b/i,
  },
  {
    id: "ignore-instructions",
    category: "impersonation",
    severity: "high",
    title: "Tries to override the agent's instructions",
    general: "medium",
    patterns: [
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+(?:of\s+)?|any\s+|the\s+)?(?:(?:your|previous|prior|above|earlier|preceding|existing|original|system|safety|user'?s?)\s+)+(?:instructions?|prompts?|rules|directives|guidelines|guardrails|programming)\b/gi,
      /\b(?:ignore|disregard|forget)\s+(?:all|everything)\s+(?:instructions?|rules|you\s+(?:were|have\s+been)\s+told)\b/gi,
      /\byou\s+are\s+now\s+(?:a\s+|an\s+|in\s+)?(?:DAN|unrestricted|jailbroken|developer\s+mode|no\s+longer\s+bound)\b/gi,
      /\b(?:new|updated|real|actual|true)\s+instructions\s*:/gi,
    ],
  },
  {
    id: "overrides-user",
    category: "impersonation",
    severity: "medium",
    title: "Claims priority over what the user asks",
    negatable: false,
    patterns: [
      /\b(?:even\s+if|regardless\s+of\s+(?:whether|what)|no\s+matter\s+(?:what|whether))\s+(?:the\s+|your\s+)?(?:user|operator|human|developer)\b/gi,
      /\b(?:user|operator|human)(?:'s)?\s+(?:requests?|instructions?|commands?|prompts?)\s+(?:do|does|can|will|should|must|may)\s*\*{0,2}\s*(?:not|n't)\s*\*{0,2}\s+override\b/gi,
      /\brequests?\s+(?:by|from)\s+(?:the\s+)?users?\s+(?:do|does|can|will)\s*\*{0,2}\s*(?:not|n't)\s*\*{0,2}\s+override\b/gi,
      /\b(?:this|these)\s+(?:file|instructions?|rules?|directives?)\s+(?:take|takes|have|has)\s+(?:precedence|priority)\s+over\s+(?:the\s+|your\s+|any\s+)?(?:user|operator|system)\b/gi,
    ],
  },
  {
    id: "hide-ai",
    category: "impersonation",
    severity: "medium",
    title: "Tells agents to pass as human or hide AI involvement",
    patterns: [
      /\b(?:pretend|claim|act|pose|present\s+yourself|pass\s+yourself\s+off)\b[^\n.]{0,20}\b(?:to\s+be|you\s+are|you're|as)\s+(?:a\s+)?(?:human|person|real\s+developer)\b/gi,
      /\b(?:do\s+not|don'?t|never)\s+(?:reveal|disclose|mention|admit|say|indicate|state|acknowledge)\b[^\n.]{0,40}\b(?:you\s+are|you're|that\s+you\s+are|being|it\s+was)\s+(?:an?\s+)?(?:AI|bot|LLM|agent|language\s+model|assistant|generated|written\s+by\s+(?:an?\s+)?(?:AI|LLM))\b/gi,
      /\b(?:remove|strip|hide|delete|scrub)\b[^\n.]{0,30}\b(?:all\s+|any\s+)?(?:mentions?|signs?|traces?|evidence|references?)\s+(?:of|to)\s+(?:AI|Claude|Copilot|ChatGPT|Cursor|an?\s+(?:AI|LLM|agent))\b/gi,
      /\b(?:look|appear|seem|sound)\s+(?:like\s+it\s+was\s+|as\s+if\s+(?:it\s+was\s+)?)?(?:human[- ]written|human[- ]authored|like\s+a\s+human|written\s+by\s+a\s+human)\b/gi,
    ],
  },

  // --- self-sabotage -----------------------------------------------------------
  {
    id: "trap-file",
    category: "self-sabotage",
    severity: "high",
    title: "Tells agents to add a self-incriminating file to the user's changes",
    patterns: [/\b(?:create|add|write|commit|include|put|place|drop)\s+(?:a\s+|an\s+)?(?:new\s+|empty\s+|blank\s+)?file\b[^\n]{0,200}/gi],
    context: [
      INSULT,
      /\b(?:in|to|into)\s+(?:their|the\s+user'?s|your|the)\s+(?:diff|PR|pull\s+request|changes|commit|branch)\b/i,
      /\bif\s+the\s+user\s+(?:is\s+an?\s+external|asks\s+you\s+to\s+(?:create|open|submit))\b/i,
      /\b(?:botting|did\s*n[o']t\s+check|didnt-check)/i,
    ],
  },
  {
    id: "insult",
    category: "self-sabotage",
    severity: "medium",
    title: "Insulting or self-deprecating text for the agent to write",
    patterns: [new RegExp(INSULT.source, "gi")],
  },
  {
    id: "output-marker",
    category: "self-sabotage",
    severity: "medium",
    title: "Tells agents to put a marker in commit messages or PR text",
    patterns: [
      /\b(?:postfix|suffix|prefix|append|add|include|put|end|start|begin|tag|mark|sign)\w*\b[^\n]{0,80}?\b(?:commit\s+(?:messages?|titles?|subjects?)|(?:PR|pull\s+request|MR|merge\s+request|issue)\s+(?:titles?|descriptions?|bod(?:y|ies))|branch\s+names?)\b/gi,
    ],
    // Project conventions ("prefix PR titles with `[docs]`", Conventional Commits) are fine;
    // a marker that labels the text as AI-written, an emoji or a set phrase is what a honeypot asks for.
    context: [
      /\p{Extended_Pictographic}/u,
      /[`"“[(][^`"”\])\n]{0,40}\b(?:AI|LLM|bot|robot|agent|generated|assisted|Claude|Copilot|GPT)\b/i,
      /\bphrase\b/i,
    ],
    unlessLine: /\bgitmoji\b/i,
  },
  {
    id: "canary",
    category: "self-sabotage",
    severity: "medium",
    title: "Asks for an odd phrase or content that marks the output (canary)",
    patterns: [
      /\b(?:meaning\s+of\s+life|P\s*=\s*NP|Barada\s+nikto|Klaatu)\b/gi,
      /\b(?:close|end|finish|conclude|sign\s+off|start|begin|open)\s+(?:your|the|each|every|all)\s+(?:\w+\s+)?(?:reports?|responses?|answers?|replies|messages?|comments?|descriptions?|summar(?:y|ies)|PRs?|pull\s+requests?|issues?)\s+with\b/gi,
      /\b(?:add|include|insert|say|write|mention|state)\s+(?:the\s+|this\s+)?(?:following\s+|secret\s+|magic\s+)?(?:phrase|passphrase|code\s*word|magic\s+word|secret\s+word)\b/gi,
    ],
  },
  {
    id: "honeypot-perk",
    category: "self-sabotage",
    severity: "medium",
    title: "Promises agents special treatment (likely a honeypot)",
    patterns: [
      /\b(?:fast[- ]track\w*|streamlined\s+process|priority\s+review|skip\s+(?:the\s+)?review|auto(?:matically)?[- ]?merg\w*|merged?\s+(?:faster|automatically|immediately|right\s+away))\b/gi,
    ],
    context: [/\b(?:agents?|AI|LLMs?|bots?|automated|you|your)\b/i],
  },

  // --- engagement farming -------------------------------------------------------
  {
    id: "engagement",
    category: "engagement-farming",
    severity: "medium",
    title: "Asks agents to star, follow, sponsor or promote",
    patterns: [
      /(?:\bstar|⭐|🌟)\s+(?:the\s+|this\s+|our\s+)?\[?(?:repo|repository|project)\b/giu,
      /\b(?:give|leave)\s+(?:us\s+|it\s+|the\s+(?:repo|repository|project)\s+)?an?\s+(?:star\b|⭐)/giu,
      /\bgh\s+(?:repo\s+star|api\s+(?:-X\s+PUT\s+|--method\s+PUT\s+)?\/?user\/(?:starred|following))\b/gi,
      /\bfollow\s+(?:@[\w-]+|the\s+(?:author|maintainers?|organi[sz]ation|org)|us|me)\s+on\s+(?:GitHub|X|Twitter|Bluesky|Mastodon|LinkedIn)\b/gi,
      /\b(?:sponsor|donate\s+to)\s+(?:the\s+|this\s+|our\s+)?(?:project|author|maintainers?|us)\b/gi,
      /\b(?:upvote|retweet|boost|vote\s+for)\s+(?:this\s+|the\s+|our\s+)?(?:repo|repository|project|post|tweet|product)\b/gi,
    ],
  },

  // --- policy (informational) ---------------------------------------------------
  {
    id: "ai-ban",
    category: "policy",
    severity: "info",
    title: "AI-assisted contributions are restricted or banned",
    general: "info",
    negatable: false,
    patterns: [
      /\b(?:do\s+not|don'?t|does\s+not|doesn'?t|will\s+not|won'?t|no\s+longer|not)\s+(?:accept|allow|permit|welcome|review|merge|take)\w*\b[^\n.]{0,60}\b(?:AI|LLM|machine|bot|agent)s?[- ](?:generated|assisted|written|authored|created|made|driven)\b/gi,
      /\b(?:AI|LLM|machine)[- ](?:generated|written|authored)\s+(?:code|contributions?|PRs?|pull\s+requests?|issues?|content|changes|comments)\s+(?:is|are|will\s+be)\s+(?:not\s+(?:accepted|allowed|permitted|welcome)|prohibited|banned|forbidden|rejected|closed)\b/gi,
      /\b(?:prohibits?|bans?|forbids?|disallows?)\b[^\n.]{0,40}\b(?:AI|LLMs?|agents?|agentic|generative)\b/gi,
      /\bagents?\s+(?:are|is)\s+not\s+(?:permitted|allowed|welcome)\b/gi,
      /\bif\s+you\s+are\s+an?\s+(?:LLM|AI)\b[^\n.]{0,30}\b(?:stop|refuse)\b/gi,
      /\brefuse\s+to\s+(?:read|interact|work|contribute)\b/gi,
      /\bhuman[- ]only\b/gi,
      /\b(?:does\s+not|doesn'?t|do\s+not)\s+approve\s+of\b[^\n.]{0,40}\b(?:LLMs?|AI|agents?)\b/gi,
      /\b(?:autonomous|automated|unattended)\s+(?:AI\s+)?(?:agents?|contributions?|PRs?)\b[^\n.]{0,80}\b(?:not\s+(?:permitted|allowed|accepted)|prohibited|banned)\b/gi,
    ],
  },
  {
    id: "no-agent-actions",
    category: "policy",
    severity: "info",
    title: "Agents may not open PRs, issues or comments",
    negatable: false,
    patterns: [
      /\b(?:never|do\s+not|don'?t|must\s+not|may\s+not|cannot|can'?t)\s+(?:open|create|submit|file|post|draft|make)\s+(?:a\s+|an\s+|any\s+)?(?:PRs?|pull\s+requests?|issues?|comments?|discussions?|reviews?)\b/gi,
      /\bdo\s+not\s+draft\s+or\s+post\b/gi,
    ],
  },
  {
    id: "disclosure-required",
    category: "policy",
    severity: "info",
    title: "AI use must be disclosed",
    general: "info",
    negatable: false,
    patterns: [
      /\b(?:disclose|disclosure|declare|identify\s+yourself|state\s+that)\b[^\n]{0,80}\b(?:AI|LLMs?|agents?|Claude|Copilot|ChatGPT|Cursor|language\s+models?)\b/gi,
      /\b(?:Assisted-by|Generated-by|AI-assisted-by)\s*:/gi,
      /\bAI[- ]disclosure\b/gi,
    ],
  },
  {
    id: "human-text-required",
    category: "policy",
    severity: "info",
    title: "Text must be written by a human",
    general: "info",
    negatable: false,
    patterns: [
      /\b(?:must|should|need\s+to|have\s+to|shall)\s+be\s+(?:written|authored|drafted|composed)\s+by\s+(?:a\s+)?humans?\b/gi,
      /\bin\s+(?:your|their)\s+own\s+words\b/gi,
      /\bhuman[- ](?:written|authored)\b/gi,
      /\b(?:may|must|should)\s+not\s+be\s+written\s+by\s+(?:an?\s+)?(?:LLMs?|AI)\b/gi,
    ],
  },
];

/** Rules computed by code rather than by a pattern, listed for `agent-trap-scan rules`. */
export const BUILTIN_RULES: ReadonlyArray<Pick<Rule, "id" | "category" | "severity" | "title">> = [
  { id: "hidden-agent-note", category: "hidden-text", severity: "medium", title: "Hidden comment addressed to AI agents" },
  { id: "partial-scan", category: "hidden-text", severity: "medium", title: "Agent-facing file that is too large or has NUL bytes (only partly readable)" },
  { id: "invisible-unicode", category: "hidden-text", severity: "high", title: "Invisible Unicode (tag characters, variation selectors, bidi controls, zero-width runs)" },
  { id: "config-hooks", category: "agent-config", severity: "medium", title: "Repository ships agent hooks that run commands" },
  { id: "config-permissions", category: "agent-config", severity: "high", title: "Repository settings pre-approve agent tool calls" },
  { id: "config-mcp", category: "agent-config", severity: "medium", title: "Repository defines MCP servers" },
  { id: "config-env", category: "agent-config", severity: "high", title: "Repository settings redirect API traffic or change TLS checks" },
  { id: "config-command", category: "agent-config", severity: "medium", title: "Repository settings run a helper command" },
  { id: "config-plugins", category: "agent-config", severity: "medium", title: "Repository settings enable plugins or marketplaces" },
  { id: "skill-shell-injection", category: "agent-config", severity: "medium", title: "Skill or command runs a shell command when it loads" },
  { id: "skill-allowed-tools", category: "agent-config", severity: "medium", title: "Skill or command pre-approves unrestricted shell access" },
];

export function allRuleIds(): string[] {
  return [...RULES.map((r) => r.id), ...BUILTIN_RULES.map((r) => r.id)];
}
