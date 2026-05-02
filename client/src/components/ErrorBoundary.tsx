import React from 'react';

interface State {
  err: Error | null;
}

interface Props {
  children: React.ReactNode;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    // Log to console for local dev visibility. The server has no error-collection
    // endpoint yet — when it does, POST { message, stack, componentStack } here.
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught render error', err, info?.componentStack);
  }

  handleReload = () => {
    // Hard reload — clears component state and lets the user back into the app.
    window.location.reload();
  };

  render() {
    if (!this.state.err) return this.props.children;

    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#0a1929',
          color: '#fff',
          fontFamily: '"Inter", "Roboto", sans-serif',
          padding: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        role="alert"
      >
        <div style={{ maxWidth: 560, background: '#132f4c', padding: 32, borderRadius: 8 }}>
          <h1 style={{ marginTop: 0, color: '#fbc02d' }}>FlashAware crashed</h1>
          <p>
            The dashboard hit an unexpected error. Your alerts are still being processed by the
            server.
          </p>
          <p style={{ fontSize: 13, color: '#aaa', wordBreak: 'break-word' }}>
            {this.state.err.message}
          </p>
          <button
            onClick={this.handleReload}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              background: '#fbc02d',
              color: '#0a1929',
              border: 'none',
              borderRadius: 4,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Reload dashboard
          </button>
        </div>
      </div>
    );
  }
}
