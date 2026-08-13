import type { ReactNode } from "react";

export const metadata = {
  title: "IKI Salesforce Product MCP",
  description: "Private remote MCP server for creating/updating Salesforce Product2 records.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
