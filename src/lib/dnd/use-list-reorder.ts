"use client";

import { useState, type DragEvent } from "react";

export type ListReorderDropTargetProps = {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onDragEnd: () => void;
};

export type ListReorderItemProps = ListReorderDropTargetProps & {
  draggable: true;
  onDragStart: (e: DragEvent) => void;
};

export function useListReorder<T>({
  items,
  onReorder,
  onDragStart: onDragStartCallback,
  onDragEnd: onDragEndCallback,
}: {
  items: T[];
  onReorder: (next: T[]) => void;
  onDragStart?: (index: number) => void;
  onDragEnd?: () => void;
}): {
  getItemProps: (index: number) => ListReorderItemProps;
  getDropTargetProps: (index: number) => ListReorderDropTargetProps;
  dragIndex: number | null;
  dragOverIndex: number | null;
} {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
  }

  function endDrag() {
    setDragIndex(null);
    setDragOverIndex(null);
    onDragEndCallback?.();
  }

  function getDropTargetProps(index: number): ListReorderDropTargetProps {
    return {
      onDragOver: (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverIndex(index);
      },
      onDragLeave: () => setDragOverIndex(null),
      onDrop: (e) => {
        e.preventDefault();
        if (dragIndex !== null) reorder(dragIndex, index);
        endDrag();
      },
      onDragEnd: endDrag,
    };
  }

  function getItemProps(index: number): ListReorderItemProps {
    return {
      ...getDropTargetProps(index),
      draggable: true,
      onDragStart: (e) => {
        setDragIndex(index);
        onDragStartCallback?.(index);
        try {
          e.dataTransfer.setData("text/plain", String(index));
        } catch {
          // Some environments restrict dataTransfer; ignore.
        }
        e.dataTransfer.effectAllowed = "move";
      },
    };
  }

  return { getItemProps, getDropTargetProps, dragIndex, dragOverIndex };
}
