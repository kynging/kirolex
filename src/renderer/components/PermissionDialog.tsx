import React from 'react';

interface PermissionDialogProps {
  request: {
    requestId: number;
    sessionId: string;
    tool?: string;
    description?: string;
  };
  onRespond: (granted: boolean) => void;
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({
  request,
  onRespond,
}) => {
  return (
    <>
      <div className="overlay" onClick={() => onRespond(false)} />
      <div className="permission-dialog">
        <h3>🔐 Permission Required</h3>
        <p>
          The agent wants to use: <strong>{request.tool || 'Unknown tool'}</strong>
        </p>
        {request.description && (
          <p style={{ 
            background: 'var(--bg-tertiary)', 
            padding: '10px 12px', 
            borderRadius: 6,
            fontFamily: 'monospace',
            fontSize: 12,
          }}>
            {request.description}
          </p>
        )}
        <div className="actions">
          <button className="btn deny" onClick={() => onRespond(false)}>
            Deny
          </button>
          <button className="btn allow" onClick={() => onRespond(true)}>
            Allow
          </button>
        </div>
      </div>
    </>
  );
};
