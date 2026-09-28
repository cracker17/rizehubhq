// Browser checks used by the playwright tool and the automatic QA evidence step.
import { navigate, openGuardedPage, OVERFLOW_SCRIPT, VIEWPORT_HEIGHT, warmLazyContent, type OpenPageOptions, type OverflowReport } from './browser';
import { safeName, type EvidenceStore } from './evidence';
import { checkUrlShape } from './net';

export interface ShotResult { width: number; ref: string; localPath: string; bytes: number; warning?: string }
export interface ScreenshotRun {
  url: string; finalUrl: string; status: number | null; title: string;
  shots: ShotResult[]; consoleErrors: string[]; failedResponses: string[]; blocked: string[];
  overflow: OverflowReport | null; viaVault: boolean;
}

export interface CheckEnv extends OpenPageOptions { evidence: EvidenceStore; taskId: string; now?: () => Date }

const stamp = (env: CheckEnv) => (env.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Screenshots at each width (+ console errors, and a 375px overflow check when 375 is included). */
export async function captureScreenshots(url: string, widths: number[], fullPage: boolean, env: CheckEnv): Promise<ScreenshotRun> {
  checkUrlShape(url, env.net.allowPrivateHosts);
  const s = await openGuardedPage(env);
  try {
    const shots: ShotResult[] = [];
    let status: number | null = null;
    let overflow: OverflowReport | null = null;
    const ts = stamp(env);
    for (const [i, w] of widths.entries()) {
      await s.page.setViewportSize({ width: w, height: VIEWPORT_HEIGHT[w] ?? 900 });
      const st = await navigate(s.page, url);
      if (i === 0) status = st;
      if (fullPage) await warmLazyContent(s.page);
      if (w <= 414 && !overflow) overflow = await s.page.evaluate<OverflowReport>(OVERFLOW_SCRIPT).catch(() => null);
      const buf = await s.page.screenshot({ fullPage, type: 'jpeg', quality: 80 });
      const saved = await env.evidence.save(env.taskId, `screenshots/${ts}-${safeName(url)}-${w}.jpg`, buf, 'image/jpeg');
      shots.push({ width: w, ref: saved.ref, localPath: saved.localPath, bytes: buf.length, warning: saved.warning });
    }
    return {
      url, finalUrl: s.page.url(), status, title: await s.page.title().catch(() => ''), shots,
      consoleErrors: s.consoleErrors, failedResponses: s.failedResponses, blocked: s.blocked, overflow, viaVault: s.viaVault,
    };
  } finally {
    await s.close();
  }
}

export async function collectConsoleErrors(url: string, env: CheckEnv): Promise<{ finalUrl: string; status: number | null; consoleErrors: string[]; failedResponses: string[]; blocked: string[] }> {
  checkUrlShape(url, env.net.allowPrivateHosts);
  const s = await openGuardedPage(env);
  try {
    const status = await navigate(s.page, url);
    await s.page.waitForTimeout(1500).catch(() => undefined); // late errors from deferred scripts
    return { finalUrl: s.page.url(), status, consoleErrors: s.consoleErrors, failedResponses: s.failedResponses, blocked: s.blocked };
  } finally {
    await s.close();
  }
}

export async function checkMobileOverflow(url: string, width: number, env: CheckEnv): Promise<OverflowReport & { finalUrl: string }> {
  checkUrlShape(url, env.net.allowPrivateHosts);
  const s = await openGuardedPage(env);
  try {
    await s.page.setViewportSize({ width, height: VIEWPORT_HEIGHT[width] ?? 812 });
    await navigate(s.page, url);
    const r = await s.page.evaluate<OverflowReport>(OVERFLOW_SCRIPT);
    return { ...r, finalUrl: s.page.url() };
  } finally {
    await s.close();
  }
}

export interface Step {
  action: 'click' | 'fill' | 'press' | 'select' | 'check' | 'wait_for' | 'expect_text' | 'screenshot' | 'wait';
  selector?: string;
  value?: string;
  timeout_ms?: number;
}
export interface StepResult { i: number; action: string; selector?: string; ok: boolean; note: string }

/** Runs click/fill steps on a page (form checks). Non-GET requests stay blocked unless allowPost on a preview host. */
export async function runSteps(url: string, steps: Step[], env: CheckEnv & { width?: number }): Promise<{
  results: StepResult[]; finalUrl: string; consoleErrors: string[]; failedResponses: string[]; blocked: string[]; shots: ShotResult[];
}> {
  checkUrlShape(url, env.net.allowPrivateHosts);
  const s = await openGuardedPage(env);
  const results: StepResult[] = [];
  const shots: ShotResult[] = [];
  const ts = stamp(env);
  try {
    const w = env.width ?? 1440;
    await s.page.setViewportSize({ width: w, height: VIEWPORT_HEIGHT[w] ?? 900 });
    await navigate(s.page, url);
    for (const [i, st] of steps.entries()) {
      const t = Math.min(st.timeout_ms ?? 10_000, 30_000);
      const loc = () => {
        if (!st.selector) throw new Error('selector is required for this action');
        return s.page.locator(st.selector).first();
      };
      try {
        let note = 'ok';
        switch (st.action) {
          case 'click': await loc().click({ timeout: t }); await s.page.waitForLoadState('load', { timeout: t }).catch(() => undefined); break;
          case 'fill': await loc().fill(st.value ?? '', { timeout: t }); break;
          case 'press': await loc().press(st.value ?? 'Enter', { timeout: t }); break;
          case 'select': await loc().selectOption(st.value ?? '', { timeout: t }); break;
          case 'check': await loc().check({ timeout: t }); break;
          case 'wait_for': await loc().waitFor({ state: 'visible', timeout: t }); break;
          case 'wait': await s.page.waitForTimeout(Math.min(Number(st.value ?? 1000) || 1000, 10_000)); break;
          case 'expect_text': {
            const text = st.selector ? await loc().innerText({ timeout: t }) : await s.page.evaluate<string>('document.body ? document.body.innerText : ""');
            const want = st.value ?? '';
            if (!text.toLowerCase().includes(want.toLowerCase())) throw new Error(`text "${want.slice(0, 80)}" not found`);
            note = `found "${want.slice(0, 80)}"`;
            break;
          }
          case 'screenshot': {
            const buf = await s.page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 });
            const saved = await env.evidence.save(env.taskId, `screenshots/${ts}-step${i + 1}-${safeName(url)}.jpg`, buf, 'image/jpeg');
            shots.push({ width: w, ref: saved.ref, localPath: saved.localPath, bytes: buf.length, warning: saved.warning });
            note = saved.ref;
            break;
          }
        }
        results.push({ i: i + 1, action: st.action, selector: st.selector, ok: true, note });
      } catch (e) {
        results.push({ i: i + 1, action: st.action, selector: st.selector, ok: false, note: (e instanceof Error ? e.message.split('\n')[0]! : String(e)).slice(0, 300) });
        break; // later steps depend on earlier ones
      }
    }
    return { results, finalUrl: s.page.url(), consoleErrors: s.consoleErrors, failedResponses: s.failedResponses, blocked: s.blocked, shots };
  } finally {
    await s.close();
  }
}
