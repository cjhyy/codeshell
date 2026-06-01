import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    // PLAIN style: badges are outlined by default, not solid fills.
    variants: {
      variant: {
        default: "border-border text-foreground",
        accent: "border-primary/40 text-primary",
        success: "border-status-ok/40 bg-status-ok/10 text-status-ok",
        warning: "border-status-warn/40 bg-status-warn/10 text-status-warn",
        error: "border-status-err/40 bg-status-err/10 text-status-err",
        info: "border-status-running/40 bg-status-running/10 text-status-running",
        secondary: "border-border text-muted-foreground",
        destructive: "border-destructive/40 text-destructive",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
