import React from "react";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({ label, children, className = "", ...rest }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-btn ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
