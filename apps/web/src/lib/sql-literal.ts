/** Renders a SQL single-quoted string literal with embedded quotes doubled. */
export const sqlStringLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Renders a SQL identifier with embedded double quotes doubled. */
export const sqlIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
