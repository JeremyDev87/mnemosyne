import * as React from "react";
import { cn } from "@/lib/utils";

export function Alert({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="status" className={cn("rounded-lg border border-line bg-surface p-4", className)} {...props} />;
}
