"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

interface AnimatedEmptyStateProps {
  children: ReactNode;
}

export function AnimatedEmptyState({ children }: AnimatedEmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}
