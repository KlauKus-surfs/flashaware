// client/src/components/JsonDiff.tsx
import React from 'react';
import { Box, Typography, Table, TableBody, TableCell, TableRow, TableHead } from '@mui/material';

interface JsonDiffProps {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function JsonDiff({ before, after }: JsonDiffProps) {
  const keys = Array.from(
    new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ).sort();

  if (keys.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No fields recorded.
      </Typography>
    );
  }

  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Field</TableCell>
          <TableCell>Before</TableCell>
          <TableCell>After</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {keys.map((k) => {
          const b = (before ?? {})[k];
          const a = (after ?? {})[k];
          const changed = JSON.stringify(b) !== JSON.stringify(a);
          return (
            <TableRow key={k} sx={changed ? { bgcolor: 'rgba(255,193,7,0.08)' } : undefined}>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{k}</TableCell>
              <TableCell
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: changed ? 'error.main' : 'text.secondary',
                }}
              >
                {b === undefined ? <em>—</em> : fmt(b)}
              </TableCell>
              <TableCell
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 12,
                  color: changed ? 'success.main' : 'text.secondary',
                }}
              >
                {a === undefined ? <em>—</em> : fmt(a)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
