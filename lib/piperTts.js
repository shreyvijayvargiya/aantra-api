/**
 * Local TTS via Piper (https://github.com/rhasspy/piper) — no cloud TTS usage when binary + model are installed.
 */
import { spawn } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { existsSync } from "node:fs";

function getPiperBin() {
	const b = process.env.PIPER_BIN?.trim() || process.env.PIPER_PATH?.trim();
	if (b && existsSync(b)) return b;
	for (const p of ["/opt/homebrew/bin/piper", "/usr/local/bin/piper", "piper"]) {
		if (p === "piper" || existsSync(p)) return p;
	}
	return "piper";
}

function getDefaultModel() {
	return process.env.PIPER_MODEL?.trim() || "";
}

/**
 * @returns {boolean}
 */
export function isPiperConfigured() {
	return Boolean(getDefaultModel());
}

/**
 * @param {{ text: string, modelPath?: string | null, signal?: AbortSignal }} opts
 * @returns {Promise<Buffer>} WAV bytes
 */
export async function piperSynthesizeWav({ text, modelPath, signal }) {
	const model = String(modelPath || "").trim() || getDefaultModel();
	if (!model) {
		throw new Error(
			"Piper TTS requires PIPER_MODEL (path to .onnx) or request field piper_model",
		);
	}
	if (!existsSync(model)) {
		throw new Error(`Piper model file not found: ${model}`);
	}
	const bin = getPiperBin();
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "piper-tts-"));
	const outPath = path.join(tmpDir, "out.wav");
	const timeout =
		Number.parseInt(process.env.PIPER_TTS_TIMEOUT_MS || "", 10) || 300_000;
	const input = String(text || "");
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(
				bin,
				["--model", model, "--output_file", outPath],
				{ stdio: ["pipe", "ignore", "pipe"] },
			);
			const t = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("Piper TTS timed out"));
			}, timeout);
			if (signal) {
				if (signal.aborted) {
					clearTimeout(t);
					child.kill("SIGKILL");
					const e = new Error("Piper TTS aborted");
					e.name = "AbortError";
					reject(e);
					return;
				}
				const onAbort = () => {
					clearTimeout(t);
					child.kill("SIGKILL");
					const e = new Error("Piper TTS aborted");
					e.name = "AbortError";
					reject(e);
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}
			let errBuf = "";
			child.stderr?.on("data", (c) => {
				errBuf += String(c);
			});
			child.on("error", (err) => {
				clearTimeout(t);
				reject(err);
			});
			child.on("close", (code) => {
				clearTimeout(t);
				if (code === 0) resolve();
				else
					reject(
						new Error(
							errBuf.trim().slice(0, 2000) || `Piper exited with code ${code}`,
						),
					);
			});
			child.stdin.write(input, "utf8", () => {
				child.stdin.end();
			});
		});
	} catch (e) {
		await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		throw new Error(
			`Piper TTS failed (is PIPER_BIN correct and piper installed?): ${e?.message || String(e)}`,
		);
	}
	const buf = await fsp.readFile(outPath);
	await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	if (!buf?.length) throw new Error("Piper produced empty WAV");
	return buf;
}
