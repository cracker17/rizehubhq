// Local media probing for video_tools/audio_tools (QA specs): ffprobe for streams, ffmpeg ebur128 for loudness.
// Files must live inside the task workspace; no network, no provider needed.
import path from 'node:path';
import type { ExecFn } from './pagespeed';

export function resolveWorkspaceFile(workspace: string, file: string): string | null {
  const abs = path.resolve(workspace, file);
  const root = path.resolve(workspace) + path.sep;
  return abs.startsWith(root) ? abs : null;
}

interface FfStream { codec_type?: string; codec_name?: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number; bit_rate?: string }

export async function probeMedia(file: string, exec: ExecFn, ffprobe = process.env.FFPROBE_PATH || 'ffprobe'): Promise<string> {
  const { stdout: out } = await exec(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60_000, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(out) as { format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string }; streams?: FfStream[] };
  const lines = [`${path.basename(file)} · ${j.format?.format_name ?? '?'} · ${Number(j.format?.duration ?? 0).toFixed(2)} s · ${Math.round(Number(j.format?.size ?? 0) / 1024)} KiB`];
  for (const s of j.streams ?? []) {
    if (s.codec_type === 'video') {
      const [n, d] = (s.r_frame_rate ?? '0/1').split('/').map(Number);
      lines.push(`video: ${s.codec_name} ${s.width}×${s.height} @ ${d ? (n! / d).toFixed(2) : '?'} fps`);
    } else if (s.codec_type === 'audio') {
      lines.push(`audio: ${s.codec_name} ${s.sample_rate} Hz × ${s.channels} ch`);
    } else if (s.codec_type) lines.push(`${s.codec_type}: ${s.codec_name ?? '?'}`);
  }
  return lines.join('\n');
}

/** Integrated loudness (LUFS) and true peak (dBTP) via ffmpeg's ebur128 filter. */
export async function measureLoudness(file: string, exec: ExecFn, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<string> {
  let out = '';
  try {
    const r = await exec(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { timeout: 180_000, env: process.env, maxBuffer: 32 * 1024 * 1024 });
    out = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    out = String((e as { stderr?: string }).stderr ?? (e instanceof Error ? e.message : e));
  }
  const summary = out.slice(out.lastIndexOf('Summary:'));
  const i = summary.match(/I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  const lra = summary.match(/LRA:\s*(-?[\d.]+)\s*LU/);
  const tp = summary.match(/True peak:[\s\S]*?Peak:\s*(-?[\d.]+|-inf)\s*dBFS/);
  if (!i) return `Could not measure loudness (ffmpeg output: ${out.slice(-300)})`;
  return `Integrated loudness ${i[1]} LUFS · LRA ${lra?.[1] ?? '?'} LU · true peak ${tp?.[1] ?? '?'} dBTP`;
}
