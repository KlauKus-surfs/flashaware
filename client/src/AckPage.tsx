import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Box, Card, CardContent, Typography, Button, CircularProgress, Alert } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { STATE_CONFIG, stateOf } from './states';
import { getAckByToken, postAckByToken, AckByTokenLookup } from './api';
import { maskEmail } from './utils/maskEmail';
import { formatSAST } from './utils/format';

type Phase =
  | { kind: 'loading' }
  | { kind: 'valid'; data: AckByTokenLookup }
  | { kind: 'already-acked'; data: AckByTokenLookup }
  | { kind: 'acked-just-now'; ackedCount: number; data: AckByTokenLookup }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

export default function AckPage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [acking, setAcking] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!token) {
      setPhase({ kind: 'invalid' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await getAckByToken(token);
        if (cancelled) return;
        if (res.data.expired) setPhase({ kind: 'expired' });
        else if (res.data.alreadyAckedAt) setPhase({ kind: 'already-acked', data: res.data });
        else setPhase({ kind: 'valid', data: res.data });
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        if (status === 404) setPhase({ kind: 'invalid' });
        else setPhase({ kind: 'error', message: err?.message ?? 'Could not load alert' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, retryKey]);

  const handleAck = async () => {
    if (!token || phase.kind !== 'valid') return;
    setAcking(true);
    try {
      const res = await postAckByToken(token);
      // The server distinguishes a fresh ack (acked > 0, alreadyAcked: false)
      // from a no-op re-ack (acked === 0, alreadyAcked: true). Show the
      // already-acked panel for the no-op so users on a stale tab see the
      // prior timestamp/actor instead of "0 deliveries cleared".
      if (res.data.alreadyAcked) {
        setPhase({
          kind: 'already-acked',
          data: {
            ...phase.data,
            alreadyAckedAt: res.data.alreadyAckedAt ?? phase.data.alreadyAckedAt,
            alreadyAckedBy: res.data.alreadyAckedBy ?? phase.data.alreadyAckedBy,
          },
        });
      } else {
        setPhase({ kind: 'acked-just-now', ackedCount: res.data.acked, data: phase.data });
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 410) setPhase({ kind: 'expired' });
      else setPhase({ kind: 'error', message: err?.message ?? 'Could not acknowledge' });
    } finally {
      setAcking(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 480, width: '100%', overflow: 'hidden' }}>
        {phase.kind === 'loading' && (
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <CircularProgress />
          </CardContent>
        )}

        {phase.kind === 'valid' &&
          (() => {
            const cfg = STATE_CONFIG[stateOf(phase.data.state)];
            return (
              <>
                <Box sx={{ bgcolor: cfg.color, color: cfg.textColor, p: 3 }}>
                  <Typography variant="h3" sx={{ fontWeight: 700, fontSize: 32 }}>
                    {cfg.emoji} {phase.data.state}
                  </Typography>
                  <Typography variant="h5" sx={{ mt: 0.5, fontWeight: 500, fontSize: 20 }}>
                    {phase.data.locationName ?? ''}
                  </Typography>
                </Box>
                <CardContent>
                  {phase.data.reason && (
                    <Typography variant="body1" sx={{ mb: 2 }}>
                      <strong>Why:</strong> {phase.data.reason}
                    </Typography>
                  )}
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mb: 3 }}
                  >
                    Sent to {maskEmail(phase.data.recipient)}
                  </Typography>
                  <Button
                    fullWidth
                    size="large"
                    variant="contained"
                    onClick={handleAck}
                    disabled={acking}
                    sx={{ minHeight: 52, fontWeight: 600 }}
                    startIcon={
                      acking ? <CircularProgress size={18} color="inherit" /> : <CheckCircleIcon />
                    }
                  >
                    {acking ? 'Acknowledging…' : "Acknowledge — I've seen this"}
                  </Button>
                </CardContent>
              </>
            );
          })()}

        {phase.kind === 'already-acked' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Already acknowledged
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              {phase.data.locationName ?? ''} ({phase.data.state ?? '—'})
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Acknowledged at {formatSAST(phase.data.alreadyAckedAt!)} SAST
              {phase.data.alreadyAckedBy ? ` by ${phase.data.alreadyAckedBy}` : ''}
            </Typography>
            <Link to="/alerts" style={{ fontSize: 13 }}>
              View dashboard →
            </Link>
          </CardContent>
        )}

        {phase.kind === 'acked-just-now' &&
          (() => {
            const cfg = STATE_CONFIG[stateOf(phase.data.state)];
            return (
              <CardContent sx={{ textAlign: 'center', py: 5 }}>
                <CheckCircleIcon sx={{ fontSize: 64, color: 'success.main', mb: 1 }} />
                <Typography variant="h5" sx={{ mb: 1 }}>
                  Acknowledged
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                  {cfg.emoji} {phase.data.state} — {phase.data.locationName ?? ''}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  {phase.ackedCount} {phase.ackedCount === 1 ? 'delivery' : 'deliveries'} cleared at{' '}
                  {formatSAST(new Date().toISOString())} SAST
                </Typography>
                <Link to="/alerts" style={{ fontSize: 13 }}>
                  View dashboard →
                </Link>
              </CardContent>
            );
          })()}

        {phase.kind === 'expired' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Link expired
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Ack links are valid for 48 hours. Open the dashboard to acknowledge instead.
            </Typography>
            <Link to="/alerts" style={{ fontSize: 13 }}>
              Open dashboard to ack →
            </Link>
          </CardContent>
        )}

        {phase.kind === 'invalid' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Link not recognised
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Check the original message and try again, or open the dashboard.
            </Typography>
            <Link to="/alerts" style={{ fontSize: 13 }}>
              Open dashboard →
            </Link>
          </CardContent>
        )}

        {phase.kind === 'error' && (
          <CardContent sx={{ textAlign: 'center', py: 5 }}>
            <Alert severity="error" sx={{ mb: 2, textAlign: 'left' }}>
              {phase.message}
            </Alert>
            <Button
              onClick={() => {
                setPhase({ kind: 'loading' });
                setRetryKey((k) => k + 1);
              }}
            >
              Retry
            </Button>
          </CardContent>
        )}
      </Card>
    </Box>
  );
}
