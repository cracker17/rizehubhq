import type { AnchorHTMLAttributes } from 'react';
export default function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  // The preview has only the office; other links stay on the page.
  return <a href={href === '/' || href === '/office' ? '#' : href} {...rest}>{children}</a>;
}
