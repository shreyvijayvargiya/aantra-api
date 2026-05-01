/**
 * Repo AST — fetch GitHub repo tree, file contents, and parse JS/TS to AST symbols.
 * Public repos only; uses GitHub API and raw.githubusercontent.com with no token.
 */

import { parse } from "@typescript-eslint/typescript-estree";

const GITHUB_API = "https://api.github.com";
const PARSEABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	"out",
]);
const MAX_FILE_SIZE = 500_000;
const BATCH_SIZE = 10;
const DEFAULT_AI_MAX_TOKENS = 16_000;

/** Rough token count for LLM context (~4 chars per token for code/JSON) */
function estimateTokens(obj) {
	const str = typeof obj === "string" ? obj : JSON.stringify(obj);
	return Math.ceil(str.length / 4);
}

/**
 * Compress file ASTs for AI: short keys (p,s,i,e), symbols as "kind:name*", external imports only.
 */
export function toAIDigest(fileASTs) {
	return fileASTs.map((f) => ({
		p: f.path,
		s: (f.symbols ?? []).map((s) => `${s.kind}:${s.name}${s.isExported ? "*" : ""}`),
		i: (f.imports ?? []).filter((i) => typeof i === "string" && !i.startsWith(".")),
		e: f.exports ?? [],
	}));
}

/**
 * Truncate digest array to fit within maxTokens. Returns compressed files + metadata.
 */
export function truncateForLLM(fileASTs, maxTokens = DEFAULT_AI_MAX_TOKENS) {
	const digest = toAIDigest(fileASTs);
	const result = [];
	let used = 0;

	for (const d of digest) {
		const cost = estimateTokens(d);
		if (used + cost > maxTokens) break;
		result.push(d);
		used += cost;
	}

	return {
		files: result,
		estimatedTokens: used,
		truncated: result.length < digest.length,
	};
}

function getLanguage(path) {
	const ext = path.substring(path.lastIndexOf("."));
	const map = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".mjs": "javascript",
		".cjs": "javascript",
		".py": "python",
		".go": "go",
		".rs": "rust",
		".java": "java",
		".cs": "csharp",
		".md": "markdown",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".css": "css",
		".html": "html",
	};
	return map[ext] ?? "unknown";
}

function shouldSkip(path) {
	return path.split("/").some((segment) => SKIP_DIRS.has(segment));
}

async function fetchGitHubAPI(url) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "repo-ast-agent/1.0",
	};

	const res = await fetch(url, { headers });
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`GitHub API ${res.status}: ${err}`);
	}
	return res.json();
}

async function fetchRepoTree(owner, repo, branch) {
	const branchData = await fetchGitHubAPI(
		`${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
	);
	const treeSha = branchData.commit.commit.tree.sha;

	const treeData = await fetchGitHubAPI(
		`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
	);

	if (treeData.truncated) {
		console.warn("⚠️ Tree truncated — repo exceeds 100k entries or 7MB");
	}

	return treeData.tree;
}

export { fetchRepoTree };

async function fetchFilesInBatches(files, owner, repo, branch) {
	const results = [];

	for (let i = 0; i < files.length; i += BATCH_SIZE) {
		const batch = files.slice(i, i + BATCH_SIZE);

		const fetched = await Promise.allSettled(
			batch.map(async (file) => {
				const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${file.path}`;
				const res = await fetch(rawUrl);
				if (!res.ok)
					throw new Error(`Failed to fetch ${file.path}: ${res.status}`);
				const content = await res.text();
				return {
					path: file.path,
					content,
					language: getLanguage(file.path),
				};
			}),
		);

		for (const result of fetched) {
			if (result.status === "fulfilled") results.push(result.value);
		}
	}

	return results;
}

function extractSymbolsFromAST(ast) {
	const symbols = [];

	function visit(node) {
		if (!node || typeof node !== "object") return;

		switch (node.type) {
			case "FunctionDeclaration":
			case "TSDeclareFunction":
				if (node.id?.name) {
					symbols.push({
						kind: "function",
						name: node.id.name,
						line: node.loc?.start?.line ?? 0,
						isExported: false,
						params:
							node.params?.map((p) => p.name ?? p.left?.name ?? "...") ?? [],
					});
				}
				break;

			case "ClassDeclaration":
				if (node.id?.name) {
					symbols.push({
						kind: "class",
						name: node.id.name,
						line: node.loc?.start?.line ?? 0,
						isExported: false,
					});
				}
				break;

			case "TSInterfaceDeclaration":
				symbols.push({
					kind: "interface",
					name: node.id?.name,
					line: node.loc?.start?.line ?? 0,
					isExported: false,
				});
				break;

			case "TSTypeAliasDeclaration":
				symbols.push({
					kind: "type",
					name: node.id?.name,
					line: node.loc?.start?.line ?? 0,
					isExported: false,
				});
				break;

			case "VariableDeclaration":
				for (const decl of node.declarations ?? []) {
					if (decl.id?.name) {
						symbols.push({
							kind: "variable",
							name: decl.id.name,
							line: node.loc?.start?.line ?? 0,
							isExported: false,
						});
					}
				}
				break;

			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
				if (node.declaration) {
					visit(node.declaration);
					const last = symbols[symbols.length - 1];
					if (last) last.isExported = true;
				}
				for (const spec of node.specifiers ?? []) {
					symbols.push({
						kind: "export",
						name: spec.exported?.name ?? spec.local?.name,
						line: node.loc?.start?.line ?? 0,
						isExported: true,
					});
				}
				return;
		}

		for (const key of Object.keys(node)) {
			const child = node[key];
			if (Array.isArray(child)) child.forEach(visit);
			else if (child && typeof child === "object" && child.type) visit(child);
		}
	}

	visit(ast);
	return symbols;
}

function extractImports(ast) {
	const imports = [];

	for (const node of ast.body ?? []) {
		if (node.type === "ImportDeclaration") {
			if (node.source?.value) imports.push(node.source.value);
		}

		if (node.type === "TSImportEqualsDeclaration") {
			const val = node.moduleReference?.expression?.value;
			if (val) imports.push(val);
		}

		if (node.type === "VariableDeclaration") {
			for (const decl of node.declarations ?? []) {
				if (
					decl.init?.type === "CallExpression" &&
					decl.init.callee?.name === "require" &&
					decl.init.arguments?.[0]?.value
				) {
					imports.push(decl.init.arguments[0].value);
				}
			}
		}
	}

	return [...new Set(imports)];
}

export function parseFileAST(file, includeFullAST = false) {
	const ext = file.path.substring(file.path.lastIndexOf("."));

	if (!PARSEABLE_EXTS.has(ext)) {
		return {
			path: file.path,
			language: file.language,
			symbols: [],
			imports: [],
			exports: [],
		};
	}

	try {
		const ast = parse(file.content, {
			jsx: ext.includes("x"),
			loc: true,
			range: false,
			tokens: false,
			comment: false,
			errorOnUnknownASTType: false,
			allowInvalidAST: true,
		});

		const symbols = extractSymbolsFromAST(ast);
		const imports = extractImports(ast);
		const exports = symbols.filter((s) => s.isExported).map((s) => s.name);

		return {
			path: file.path,
			language: file.language,
			symbols,
			imports,
			exports,
			...(includeFullAST ? { ast } : {}),
		};
	} catch (err) {
		return {
			path: file.path,
			language: file.language,
			symbols: [],
			imports: [],
			exports: [],
			error: err?.message ?? String(err),
		};
	}
}

function buildCallGraph(files) {
	const exportMap = {};
	for (const f of files) {
		for (const exp of f.exports ?? []) {
			exportMap[exp] = f.path;
		}
	}

	const graph = {};
	for (const f of files) {
		for (const imp of f.imports ?? []) {
			const match = Object.entries(exportMap).find(([, filePath]) =>
				filePath.includes(imp.replace(/^\.\.?\//, "")),
			);
			if (match) {
				const [symbol] = match;
				if (!graph[symbol]) graph[symbol] = [];
				if (!graph[symbol].includes(f.path)) {
					graph[symbol].push(f.path);
				}
			}
		}
	}

	return graph;
}

/**
 * Parse a GitHub URL into owner, repo, branch, and optional file path.
 * @returns {{ owner: string, repo: string, branch: string, path?: string, isBlob: boolean } | null }
 */
export function parseRepoUrl(url) {
	if (!url || typeof url !== "string") return null;
	const match = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/i);
	if (!match) return null;
	const [, owner, repo, branchOrPath, pathRest] = match;
	const isBlob = url.includes("/blob/");
	const branch = branchOrPath || "main";
	const path = pathRest ? pathRest.replace(/\/$/, "") : undefined;
	return {
		owner,
		repo: repo.replace(/\.git$/i, ""),
		branch,
		path: path || undefined,
		isBlob,
	};
}

/**
 * Full repo analysis: tree → filter code files → fetch contents → parse ASTs → call graph.
 * Public repos only; no token.
 */
export async function analyzeRepo(owner, repo, branch, options = {}) {
	const {
		includeFullAST = false,
		fileExtensions,
		maxFiles = 200,
		maxTokens = DEFAULT_AI_MAX_TOKENS,
	} = options;

	const tree = await fetchRepoTree(owner, repo, branch);

	const codeFiles = tree
		.filter((item) => {
			const ext = item.path.substring(item.path.lastIndexOf("."));
			const withinSizeLimit = (item.size ?? 0) < MAX_FILE_SIZE;
			const notSkipped = !shouldSkip(item.path);
			const isBlob = item.type === "blob";
			const matchesExt = fileExtensions
				? fileExtensions.some((e) => item.path.endsWith(e))
				: PARSEABLE_EXTS.has(ext);
			return isBlob && notSkipped && withinSizeLimit && matchesExt;
		})
		.slice(0, maxFiles);

	const fileTree = tree
		.filter((i) => !shouldSkip(i.path))
		.map((i) => (i.type === "tree" ? `📁 ${i.path}/` : `📄 ${i.path}`));

	const repoFiles = await fetchFilesInBatches(
		codeFiles,
		owner,
		repo,
		branch,
	);

	const fileASTs = repoFiles.map((f) => parseFileAST(f, includeFullAST));
	const callGraph = buildCallGraph(fileASTs);

	const languages = {};
	for (const f of fileASTs) {
		languages[f.language] = (languages[f.language] ?? 0) + 1;
	}

	const { files: filesForAi, estimatedTokens, truncated } = truncateForLLM(
		fileASTs,
		maxTokens,
	);

	return {
		repo: `${owner}/${repo}`,
		branch,
		totalFiles: tree.filter((i) => i.type === "blob").length,
		parsedFiles: fileASTs.length,
		fileTree,
		files: filesForAi,
		estimatedTokens,
		truncated,
		callGraph,
		summary: {
			languages,
			totalSymbols: fileASTs.reduce((acc, f) => acc + (f.symbols?.length ?? 0), 0),
			totalImports: fileASTs.reduce((acc, f) => acc + (f.imports?.length ?? 0), 0),
		},
	};
}

/**
 * Fetch a single file from GitHub raw and return AST info for it.
 * Public repos only; no token.
 */
export async function analyzeSingleFile(owner, repo, branch, filePath) {
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${filePath}`;
	const res = await fetch(rawUrl);
	if (!res.ok) throw new Error(`Failed to fetch ${filePath}: ${res.status}`);
	const content = await res.text();
	const file = { path: filePath, content, language: getLanguage(filePath) };
	const astInfo = parseFileAST(file, false);
	const { files: filesForAi, estimatedTokens, truncated } = truncateForLLM(
		[astInfo],
		DEFAULT_AI_MAX_TOKENS,
	);
	return {
		repo: `${owner}/${repo}`,
		branch,
		fileTree: [`📄 ${filePath}`],
		files: filesForAi,
		estimatedTokens,
		truncated,
		callGraph: {},
		summary: {
			languages: { [astInfo.language]: 1 },
			totalSymbols: astInfo.symbols?.length ?? 0,
			totalImports: astInfo.imports?.length ?? 0,
		},
		totalFiles: 1,
		parsedFiles: 1,
	};
}
