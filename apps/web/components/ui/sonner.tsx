'use client';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** The one app-wide toaster. Mounted once in app/layout.tsx; never mount it in pages. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
