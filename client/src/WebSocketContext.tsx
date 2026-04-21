import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useCurrentUser } from './App';
import wsService, { SocketEvents } from './websocket';

interface WebSocketContextType {
  isConnected: boolean;
  joinLocation: (locationId: string) => void;
  leaveLocation: (locationId: string) => void;
  subscribeToAlerts: (callback: (data: Parameters<SocketEvents['alert-triggered']>[0]) => void) => void;
  subscribeToRiskStateChanges: (callback: (data: Parameters<SocketEvents['risk-state-change']>[0]) => void) => void;
  subscribeToSystemHealth: (callback: (data: Parameters<SocketEvents['system-health']>[0]) => void) => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export function useWebSocket() {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
}

interface WebSocketProviderProps {
  children: ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const [isConnected, setIsConnected] = useState(false);
  const currentUser = useCurrentUser();

  useEffect(() => {
    const token = localStorage.getItem('flashaware_token');
    if (token && currentUser) {
      wsService.connect(token)
        .then(() => {
          setIsConnected(true);
        })
        .catch((error) => {
          console.error('Failed to connect WebSocket:', error);
          setIsConnected(false);
        });

      // Listen for connection status changes
      const handleConnect = () => setIsConnected(true);
      const handleDisconnect = () => setIsConnected(false);

      wsService.onRiskStateChange(() => {});
      wsService.onAlertTriggered(() => {});
      wsService.onSystemHealth(() => {});
      wsService.onError(() => {});

      return () => {
        wsService.disconnect();
        setIsConnected(false);
      };
    }
  }, [currentUser]);

  const joinLocation = (locationId: string) => {
    wsService.joinLocation(locationId);
  };

  const leaveLocation = (locationId: string) => {
    wsService.leaveLocation(locationId);
  };

  const subscribeToAlerts = (callback: (data: Parameters<SocketEvents['alert-triggered']>[0]) => void) => {
    wsService.onAlertTriggered(callback);
    return () => wsService.offAlertTriggered(callback);
  };

  const subscribeToRiskStateChanges = (callback: (data: Parameters<SocketEvents['risk-state-change']>[0]) => void) => {
    wsService.onRiskStateChange(callback);
    return () => wsService.offRiskStateChange(callback);
  };

  const subscribeToSystemHealth = (callback: (data: Parameters<SocketEvents['system-health']>[0]) => void) => {
    wsService.onSystemHealth(callback);
    return () => wsService.offSystemHealth(callback);
  };

  const value: WebSocketContextType = {
    isConnected,
    joinLocation,
    leaveLocation,
    subscribeToAlerts,
    subscribeToRiskStateChanges,
    subscribeToSystemHealth,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}
