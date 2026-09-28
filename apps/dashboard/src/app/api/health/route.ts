export function GET() {
  return Response.json({ ok: true, service: 'rizehub-hq-dashboard', time: new Date().toISOString() });
}
