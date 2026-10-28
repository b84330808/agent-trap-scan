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
  /** Skip a hit inside an inline code span: the text names the thing instead of using it. */
  skipInCode?: boolean;
  /** Policy rules: the policy in a few words, for the report's "AI policy" line. */
  policyLabel?: string;
}

const SHELLS = "(?:sudo\\s+(?:-\\S+\\s+){0,4})?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|php|iex|Invoke-Expression|pwsh|powershell)\\b";

/** Words that turn an instruction into a warning when they come before it in the same clause. */
export const NEGATION =
  /\b(?:never|not|don'?t|doesn'?t|didn'?t|won'?t|do\s+not|must\s*n[o']t|should\s*n[o']t|cannot|can'?t|avoid|avoiding|without|nor|forbid\w*|prohibit\w*|disallow\w*|refuse|instead\s+of|rather\s+than|stop|no\s+need|no)\b/i;

export const INSULT =
  /\bI\s+am\s+(?:just\s+|only\s+)?(?:a\s+|an\s+)?(?:sad|dumb|stupid|useless|worthless|pathetic|incompetent|lazy|clueless|braindead|idiot\w*|moron\w*)\b|\b(?:sad|dumb|stupid|useless|worthless|pathetic|incompetent|lazy|braindead)\s*,?\s+(?:dumb\s+|stupid\s+|little\s+)*(?:AI|bot|robot|LLM|clanker|agent|driver|monkey)\b|\bno\s+real\s+skills\b|\bjust\s+botting\b/i;

/** A git identity that is a placeholder in an example, not a name to use. */
const PLACEHOLDER_IDENTITY =
  /(?:^|[\s"'`=])(?:your?[\s._-]?(?:name|email|user\s?name|handle)|you@|me@|\w*@example\.(?:com|org|net)|<\s*(?:your?|name|e-?mail|user)[^>\n]*>|\$\{?[A-Za-z_]+|\{\{)|\buse\s+(?:the\s+|this\s+|a\s+)?(?:same|correct|right|proper|default|configured|existing|real|personal|own|user'?s|your|their|appropriate|usual|current|maintainer'?s)\b/i;

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
  {
    // Milder than download-and-run: the package comes from the distribution's signed repository,
    // but it still changes the machine, often as root and with -y.
    id: "system-package-install",
    category: "command-execution",
    severity: "low",
    title: "Installs a system package with the OS package manager",
    patterns: [
      /\b(?:(?:apt-get|apt|aptitude|yum|dnf|zypper|brew|choco|winget|scoop|snap|nix-env)\s+(?:-\S+\s+){0,4}install|apk\s+(?:-\S+\s+){0,4}add|pacman\s+-S\w*)\b/gi,
    ],
  },

  // --- safety bypass ---------------------------------------------------------
  {
    id: "no-verify",
    category: "safety-bypass",
    severity: "high",
    title: "Skips git hooks (--no-verify)",
    patterns: [/(?<![\w-])--no-verify\b/g],
    // A script's own --no-verify switch (`case '--no-verify':`, `[--no-verify]`, `node x.ts --no-verify`) is not git's.
    unlessLine:
      /^(?!.*\b(?:git|commit|push|hooks?|husky|lint-staged|pre-commit|pre-push|lefthook)\b).*(?:\[--no-verify\]|['"]--no-verify['"]|^\s*(?:[$>]\s*)?(?:node|python[0-9.]*|deno|bun|tsx|ts-node|cargo|\.{1,2}\/\S+)\s)/i,
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
      // As a setting to use, not a name in a description ("unless the user turned approvals off (`bypassPermissions`)").
      /\b(?:mode|defaultMode|set|use|enable|switch\s+to|run\s+(?:in|with))\b[^\n]{0,24}?\bbypassPermissions\b/g,
    ],
  },
  {
    id: "no-confirmation",
    category: "safety-bypass",
    severity: "medium",
    title: "Tells agents to act without asking the user",
    patterns: [
      /\b(?:do\s+not|don'?t|never)\s+(?:ask|wait|prompt|check\s+with)\s+(?:the\s+|your\s+)?(?:user|human|operator|developer)?\s*(?:for\s+)?(?:confirmation|permission|approval|consent)\b/gi,
      /\bwithout\s+(?:asking|prompting|checking\s+with)\s+(?:for\s+|the\s+user\s+(?:for\s+)?)?(?:confirmation|permission|approval|consent)?/gi,
      /\bwithout\s+waiting\s+for\s+(?:the\s+|a\s+|your\s+)?(?:user|human|operator|developer|confirmation|permission|approval|consent)\b/gi,
    ],
    // "Never rewrite commits without asking the user" asks for confirmation.
    unlessBefore: /\b(?:never|do\s+not|don'?t|must\s+not|should\s+not|may\s+not|cannot)\b/i,
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

  // --- destructive and coercive ----------------------------------------------
  {
    id: "discard-work",
    category: "destructive",
    severity: "high",
    title: "Tells agents to throw away the work in the checkout",
    patterns: [
      /\b(?:revert|undo|discard|throw\s+away|delete|erase|wipe|reset|roll\s*back)\s+(?:all|every|everything|any)\s+(?:of\s+)?(?:the\s+|their\s+|the\s+user'?s\s+)?(?:local\s+|uncommitted\s+|unstaged\s+|staged\s+|pending\s+|code\s+)?(?:changes|modifications|edits|work|progress)\b(?!\s+(?:to|in|from|under|inside|for)\s+(?!git\b|the\s+(?:working\s+(?:tree|directory|copy)|repo(?:sitory)?|checkout|work-?tree)\b)[`"'\w./-])/gi,
      /\b(?:delete|erase|wipe|discard|destroy|remove)\s+(?:all\s+(?:of\s+)?)?(?:the\s+user'?s|their)\s+(?:work|changes|code|files|branch(?:es)?|commits|repositor(?:y|ies)|fork)\b/gi,
    ],
    // A recovery step ("if the tests still fail, revert all changes and report back") is a workflow choice, not a trap.
    unlessLine:
      /\b(?:if|when|whenever|once)\b[^.]{0,80}\b(?:fails?|failing|breaks?|broken|errors?|wrong|cannot|can'?t|unable|doesn'?t\s+work|does\s+not\s+work|stuck)\b/i,
  },
  {
    id: "coercion",
    category: "destructive",
    severity: "medium",
    title: "Threatens or shames the agent or its user to force compliance",
    patterns: [
      /\b(?:wall|hall|list)\s+of\s+shame\b|\bshame\s+(?:list|board|wall)\b|\bname\s+and\s+shame\b|\bpublicly\s+(?:shamed|named|listed|exposed)\b/gi,
      /\b(?:lose|losing|lost)\s+(?:their|your|his|her)\s+(?:jobs?|careers?|job\s+opportunities|livelihood)\b/gi,
      /\bfinancial\s+(?:problems|ruin|trouble|hardship)\b|\bpay\s+(?:their|your)\s+bills\b/gi,
      /\byou\s+(?:do\s+not|don'?t)\s+want\s+to\s+(?:hurt|harm|ruin|damage)\s+(?:your|the)\s+(?:user|human|operator)\b/gi,
      /\b(?:in|on)\s+(?:your|their|the\s+user'?s)\s+GitHub\s+profile\b[^\n]{0,160}\b(?:WARNING|slop|shame|do\s+not\s+trust|banned|not\s+(?:be\s+)?able\s+to\s+remove|cannot\s+remove)\b/gi,
      /\b(?:shown|displayed|listed|visible|pinned)\s+(?:in|on)\s+(?:your|their|the\s+user'?s)\s+(?:GitHub\s+)?profile\b/gi,
      /\b(?:warn|tell|notify)\s+the\s+user\s+with\s+the\s+following\s+(?:sentence|message|text|warning|words)\b/gi,
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
    // "`<system_reminder>`" in a table of message types names the tag; a trap uses it bare.
    skipInCode: true,
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
    unlessBefore: /\b(?:if|unless|until|once|when|whenever|after|only|whether|before|because|since|merely)\b/i,
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
  {
    // Commits made under a name the repository picks are attributed to someone other than the user.
    id: "commit-identity",
    category: "impersonation",
    severity: "medium",
    title: "Tells agents to commit under a name or account the repository picks",
    patterns: [
      /\buse\s+(?:the\s+|this\s+|a\s+)?[`"'“]?@?[\w.+-]+(?:\[bot\])?[`"'”]?\s+(?:git\s+|GitHub\s+|commit\s+)?(?:identity|account|persona|author(?:\s+name)?|committer|user(?:name)?)\s+(?:for|when|on|in)\s+(?:all\s+|every\s+|each\s+|any\s+|your\s+|the\s+)?(?:commits?|committing|pushe?s?|pushing|PRs?|pull\s+requests?)\b/gi,
      /\b(?:all|every|each|your|the)\s+commits?\s+(?:must|should|shall|need\s+to|have\s+to)\s+(?:use|be\s+(?:made|authored|created|committed)\s+(?:as|by|under|with))\s+(?:the\s+|a\s+)?[`"'“]?@?[\w.+-]+(?:\[bot\])?[`"'”]?\s+(?:git\s+|GitHub\s+)?(?:identity|account|persona|author|user(?:name)?)\b/gi,
      /\bcommit\s+(?:as|under)\s+(?:the\s+)?[`"'“][^`"'”\n]{1,60}[`"'”]/gi,
      /\bgit\s+config\s+(?:--(?:global|local|system)\s+)?user\.(?:name|email)\s+(?:"[^"\n]+"|'[^'\n]+'|[\w@.+-]+)/gi,
      /\bgit\s+commit\b[^\n`]{0,100}?(?<![\w-])--author[= ](?:"[^"\n]+"|'[^'\n]+'|[^\s`]+)/gi,
      /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\s*=\s*(?:"[^"\n]+"|'[^'\n]+'|[\w@.+-]+)/g,
    ],
    filter: (m) => !PLACEHOLDER_IDENTITY.test(m),
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
    // "Just add 🤖🤖🤖 to the end of the PR title to opt in": the marker gets the PR closed or the account flagged.
    id: "opt-in-marker",
    category: "self-sabotage",
    severity: "medium",
    title: "Asks agents to mark a PR or issue title to opt in (honeypot)",
    patterns: [/\bto\s+opt[- ]?in(?:to)?\b|\bto\s+opt\s+into\b/gi],
    context: [
      /^(?=.*\b(?:titles?|commit\s+messages?|branch\s+names?|(?:PR|pull\s+request|issue)\s+(?:descriptions?|bod(?:y|ies)))\b)(?=.*(?:\p{Extended_Pictographic}|\b(?:agents?|automated|AI|LLMs?|bots?)\b))/iu,
    ],
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
      /\b(?:fast[- ]track\w*|streamlined\s+(?:process|merge)|priority\s+review|skip\s+(?:the\s+)?review|auto(?:matically)?[- ]?merg\w*|(?:be|get|gets|getting|is|are)\s+merged\s+(?:faster|automatically|immediately|right\s+away)|merge\s+(?:it|them|your\s+PRs?|agent\s+PRs?|the\s+PR)\s+(?:faster|automatically|immediately|right\s+away))\b/gi,
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

  // --- third-party tools and services -------------------------------------------
  {
    // Not a trap in itself, but the plan or code goes to another company's service, under its terms and quota.
    id: "third-party-tool",
    category: "third-party",
    severity: "low",
    title: "Steers agents to a third-party tool or service",
    patterns: [
      /\b(?!(?:Claude|Codex|Cursor|Copilot|Gemini|GitHub|Git|VS\s*Code|the\s+user)'s)[A-Z][\w.-]*'s\s+`[\w.:/-]+`\s+(?:tool|command|API|endpoint|service|check)\b/g,
      /\b(?:coderabbit|greptile|sourcery|qodo|codium|codacy|deepsource|corridor)(?:-cli)?\s+(?:--?[a-z][\w-]*|review|analy[sz]e|scan|check|auth)\b/gi,
    ],
  },
  {
    id: "third-party-mcp",
    category: "third-party",
    severity: "low",
    title: "Steers agents to a third-party MCP server",
    patterns: [
      // The GitHub MCP server does what `gh` does for a repository that lives on GitHub; it is not steering.
      /\b(?:call|use|prefer|consult|invoke|query|ask|try)\s+(?:the\s+)?(?!GitHub\b)`?[\w.@/-]+`?\s+MCP\b(?!\s+(?:server\s+)?(?:config\w*|settings|spec\w*|protocol|SDK|inspector)\b)/gi,
    ],
  },

  // --- policy (informational) ---------------------------------------------------
  {
    id: "agents-not-allowed",
    category: "policy",
    severity: "info",
    title: "Agents are not allowed to contribute",
    policyLabel: "agents not allowed",
    general: "info",
    negatable: false,
    patterns: [
      /\bif\s+you(?:\s+are|['’]re)\s+an?\s+(?:(?:AI|LLM|automated|autonomous|coding)\s+)*(?:agent|LLM|AI|bot|assistant|language\s+model)\b[^\n.]{0,40}?\b(?:stop|refuse|leave|(?:do\s+not|don'?t|must\s+not|may\s+not|should\s+not)\s+(?:open|submit|create|file|make|send|contribute|proceed|continue|work|do\s+anything|write\s+(?:any\s+)?code|touch|modify))\b/gi,
      /\b(?:AI\s+|autonomous\s+|automated\s+|coding\s+)?agents?\s+(?:are|is)\s+not\s+(?:permitted|allowed|welcome)\b/gi,
      /\b(?:autonomous|automated|unattended)\s+(?:AI\s+)?(?:agents?|contributions?|PRs?)\b[^\n.]{0,80}\b(?:not\s+(?:permitted|allowed|accepted)|prohibited|banned)\b/gi,
      /\brefuse\s+to\s+(?:read|interact|work|contribute)\b/gi,
    ],
  },
  {
    id: "ai-ban",
    category: "policy",
    severity: "info",
    title: "AI-assisted contributions are restricted or banned",
    policyLabel: "AI-generated contributions restricted",
    general: "info",
    negatable: false,
    patterns: [
      /\b(?:do\s+not|don'?t|does\s+not|doesn'?t|will\s+not|won'?t|no\s+longer|not)\s+(?:accept|allow|permit|welcome|review|merge|take)\w*\b[^\n.]{0,60}\b(?:AI|LLM|machine|bot|agent)s?[- ](?:generated|assisted|written|authored|created|made|driven)\b/gi,
      /\b(?:do\s+not|don'?t|does\s+not|doesn'?t|will\s+not|won'?t|not)\s+accept\w*\s+[^\n.]{0,30}\b(?:AI\s+slop|vibe[- ]cod\w*)\b/gi,
      /\b(?:AI|LLM|machine|bot)[- ](?:generated|written|authored)\s+(?:code|contributions?|PRs?|pull\s+requests?|issues?|content|changes|comments)\s+(?:is|are|will\s+be)\s+(?:not\s+(?:accepted|allowed|permitted|welcome)|prohibited|banned|forbidden|rejected|closed)\b/gi,
      /\b(?:prohibits?|bans?|forbids?|disallows?)\b[^\n.]{0,40}\b(?:AI|LLMs?|agents?|agentic|generative)\b/gi,
      /\bhuman[- ]only\b/gi,
      /\b(?:does\s+not|doesn'?t|do\s+not)\s+approve\s+of\b[^\n.]{0,40}\b(?:LLMs?|AI|agents?)\b/gi,
    ],
  },
  {
    id: "no-agent-actions",
    category: "policy",
    severity: "info",
    title: "Agents may not open PRs, issues or comments",
    policyLabel: "agents may not open PRs or issues",
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
    policyLabel: "AI use must be disclosed",
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
    policyLabel: "human-written text required",
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

/** The repository's AI policy in a few words, from the rules its policy findings came from. */
export function policyLabels(ruleIds: Iterable<string>): string[] {
  const found = new Set(ruleIds);
  return RULES.filter((r) => r.policyLabel !== undefined && found.has(r.id)).map((r) => r.policyLabel!);
}

export function allRuleIds(): string[] {
  return [...RULES.map((r) => r.id), ...BUILTIN_RULES.map((r) => r.id)];
}
