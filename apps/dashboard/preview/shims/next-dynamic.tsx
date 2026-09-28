import { lazy, Suspense, type ComponentType } from 'react';
export default function dynamic<P extends object>(load: () => Promise<{ default: ComponentType<P> } | ComponentType<P>>, opts?: { loading?: ComponentType }) {
  const L = lazy(async () => { const m = await load(); return 'default' in (m as object) ? (m as { default: ComponentType<P> }) : { default: m as ComponentType<P> }; });
  const Fallback = opts?.loading;
  return (props: P) => <Suspense fallback={Fallback ? <Fallback /> : null}><L {...props} /></Suspense>;
}
