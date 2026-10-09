import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../../account.css";

// Sign-in and the console are for one person each; none of it belongs in a search index.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <div className="acct-root">{children}</div>;
}
