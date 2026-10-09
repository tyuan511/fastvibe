/** Grey placeholders shaped like the account card or the device list, shown while the API answers. */
export function ConsoleSkeleton({ pathname, label, body = false }: { pathname: string; label: string; body?: boolean }) {
  const devices = pathname.startsWith("/console/sessions");
  return (
    <div className="acct-skeleton" role="status" aria-label={label}>
      {!body && <><span className="acct-bone title" /><span className="acct-bone lead" /></>}
      {devices ? (
        <ul className="acct-list">
          {[0, 1, 2].map((row) => (
            <li key={row} className="acct-row">
              <div className="acct-row-main">
                <span className="acct-bone line" />
                <span className="acct-bone meta" />
              </div>
              <span className="acct-bone button" />
            </li>
          ))}
        </ul>
      ) : (
        <div className="acct-panel">
          <div className="acct-profile">
            <span className="acct-bone avatar" />
            <div>
              <span className="acct-bone name" />
              <span className="acct-bone link" />
            </div>
          </div>
          <div className="acct-facts">
            {[0, 1, 2, 3].map((row) => (
              <div key={row}>
                <span className="acct-bone label" />
                <span className="acct-bone value" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
