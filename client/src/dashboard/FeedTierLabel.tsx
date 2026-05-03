import { Box, Tooltip } from '@mui/material';
import InfoTip from '../components/InfoTip';
import { helpBody, helpTitle } from '../help/copy';

// Inline feed-tier badge so an 11-min-old feed is visibly different from a
// 1-min-old one. The /api/health endpoint emits `feedTier` ∈
// {'healthy','lagging','stale','unknown'} so the rule lives server-side
// (single source of truth for "what counts as healthy").
export function FeedTierLabel({
  tier,
  ageMin,
}: {
  tier?: string;
  ageMin: number | null | undefined;
}) {
  if (ageMin == null) return <span>Feed: unknown</span>;
  const cfg: Record<string, { label: string; color: string; tooltip: string }> = {
    healthy: {
      label: 'Healthy',
      color: '#66bb6a',
      tooltip: 'Data ≤ 12 min old — current within EUMETSAT MTG-LI cadence (10-min products).',
    },
    lagging: {
      label: 'Lagging',
      color: '#fbc02d',
      tooltip:
        'Data 13–20 min old — one MTG-LI cycle has been missed; treat decisions with caution.',
    },
    stale: {
      label: 'Stale',
      color: '#ef5350',
      tooltip:
        'Data > 20 min old — two or more MTG-LI cycles missed. Engine flips to NO DATA FEED at 25 min.',
    },
    unknown: { label: 'Unknown', color: '#9e9e9e', tooltip: 'Feed status unavailable.' },
  };
  const c = cfg[tier ?? 'unknown'] ?? cfg.unknown;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
      <Tooltip title={c.tooltip}>
        <span style={{ cursor: 'help' }}>
          Feed: <span style={{ color: c.color, fontWeight: 600 }}>{c.label}</span> ({ageMin} min
          old)
        </span>
      </Tooltip>
      <InfoTip
        inline
        variant="dialog"
        title={helpTitle('feed_health')}
        body={helpBody('feed_health')}
      />
    </Box>
  );
}
