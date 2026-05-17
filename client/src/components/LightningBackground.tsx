import React from 'react';
import { Box, useTheme } from '@mui/material';
import { keyframes } from '@emotion/react';

// Three offset keyframes so the bolts don't all twitch in unison. Each spends
// ~92% of its cycle near-invisible, then a quick double-flash, then back.
// Tuned to register as "ambient storm" peripherally rather than demanding
// attention — this is a login screen, not a casino.
const pulseA = keyframes`
  0%, 91%, 100% { opacity: 0.06; }
  92%          { opacity: 0.55; }
  92.6%        { opacity: 0.12; }
  93.2%        { opacity: 0.42; }
  94%          { opacity: 0.06; }
`;
const pulseB = keyframes`
  0%, 88%, 100% { opacity: 0.05; }
  89%          { opacity: 0.45; }
  89.5%        { opacity: 0.10; }
  90.1%        { opacity: 0.38; }
  91%          { opacity: 0.05; }
`;
const pulseC = keyframes`
  0%, 95%, 100% { opacity: 0.04; }
  96%          { opacity: 0.40; }
  96.5%        { opacity: 0.10; }
  97%          { opacity: 0.30; }
  98%          { opacity: 0.04; }
`;

const BOLT_PATH = 'M50 0 L14 110 L42 110 L26 200 L82 70 L54 70 L72 0 Z';

interface BoltProps {
  sx: object;
  animation: ReturnType<typeof keyframes>;
  duration: string;
  delay: string;
}

function Bolt({ sx, animation, duration, delay }: BoltProps) {
  return (
    <Box
      component="svg"
      viewBox="0 0 100 200"
      sx={{
        position: 'absolute',
        pointerEvents: 'none',
        opacity: 0.06,
        animation: `${animation} ${duration} ease-in-out infinite`,
        animationDelay: delay,
        // Honour user accessibility preference — disable the flash entirely
        // so it can't act as a vestibular/photosensitive trigger.
        '@media (prefers-reduced-motion: reduce)': {
          animation: 'none',
          opacity: 0.08,
        },
        ...sx,
      }}
      aria-hidden="true"
    >
      <path d={BOLT_PATH} fill="#fbc02d" />
    </Box>
  );
}

interface LightningBackgroundProps {
  children: React.ReactNode;
}

/**
 * Full-viewport decorative backdrop for unauthenticated screens (login,
 * register, password-reset). Provides a radial gradient + occasional
 * ambient lightning flashes. Render its children inline — the component
 * places them above the decorative layer with `position: relative`.
 */
export default function LightningBackground({ children }: LightningBackgroundProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const gradient = isDark
    ? 'radial-gradient(ellipse at 50% 18%, #1c3a64 0%, #0a1929 55%, #04101e 100%)'
    : 'radial-gradient(ellipse at 50% 18%, #e8eef7 0%, #f5f6fa 55%, #dde3ee 100%)';

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        background: gradient,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Bolt
        sx={{ top: '6%', left: '8%', width: { xs: 90, sm: 140 }, height: { xs: 180, sm: 280 } }}
        animation={pulseA}
        duration="9s"
        delay="0s"
      />
      <Bolt
        sx={{
          top: '20%',
          right: '10%',
          width: { xs: 70, sm: 110 },
          height: { xs: 140, sm: 220 },
          transform: 'rotate(14deg)',
        }}
        animation={pulseB}
        duration="11s"
        delay="2.7s"
      />
      <Bolt
        sx={{
          bottom: '4%',
          left: '22%',
          width: { xs: 60, sm: 90 },
          height: { xs: 120, sm: 180 },
          transform: 'rotate(-8deg)',
        }}
        animation={pulseC}
        duration="13s"
        delay="5.1s"
      />
      <Box
        sx={{
          position: 'relative',
          zIndex: 1,
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          // Allow tall content (forms with errors) to scroll instead of clipping.
          overflowY: 'auto',
        }}
      >
        {children}
      </Box>
    </Box>
  );
}
