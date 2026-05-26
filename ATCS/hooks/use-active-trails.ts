import { useEffect, useState } from "react";
import { readTrails } from "@/lib/storage";

export function useActiveTrailCount(pollMs = 1000): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () => setCount(readTrails().filter((t) => t.active).length);
    update();
    const interval = setInterval(update, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return count;
}
