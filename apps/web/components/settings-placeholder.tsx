/** Placeholder destination so Settings links work; the Settings forms land in the next job. */
export function SettingsPlaceholder({ title }: { title: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">Settings are coming soon.</p>
    </section>
  );
}
