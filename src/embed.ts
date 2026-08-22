import { join } from "node:path";
import { dataDir, loadSettings } from "./settings";

type Pipe = (text: string | string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array; dims: number[] }>;

let pipe: Pipe | null | undefined;

/** True inside a `bun build --compile` binary; the native onnxruntime addon cannot be bundled, so embeddings are off there. */
export const COMPILED = /\$bunfs|~BUN/.test(import.meta.dir);

async function load(): Promise<Pipe | null> {
  if (pipe !== undefined) return pipe;
  const s = loadSettings();
  if (!s.embeddings || COMPILED) return (pipe = null);
  try {
    const mod = (await import("@huggingface/transformers")) as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<Pipe>;
      env: { cacheDir: string; allowLocalModels: boolean };
    };
    mod.env.cacheDir = join(dataDir(), "models");
    pipe = await mod.pipeline("feature-extraction", s.embeddingModel, { dtype: "q8" });
    return pipe;
  } catch {
    return (pipe = null);
  }
}

export async function embed(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const p = await load();
  if (!p) return null;
  const out = await p(texts, { pooling: "cls", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) result.push(out.data.slice(i * dim, (i + 1) * dim));
  return result;
}

export async function embedOne(text: string): Promise<Float32Array | null> {
  const r = await embed([text]);
  return r ? r[0] : null;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized
}

export async function embeddingsAvailable(): Promise<boolean> {
  return (await load()) !== null;
}
