'use client';

import { useEffect, useState, useCallback } from 'react';
import { rgbToHex } from './color.js';

const MAX_COLOR_HISTORY = 16;
const DB_KEY = 'teds-tools-data';

function emptyDB() {
  return {
    colorHistory: [],
  };
}

function loadDB() {
  if (typeof window === 'undefined') return emptyDB();
  try {
    const raw = window.localStorage.getItem(DB_KEY);
    if (raw) return { ...emptyDB(), ...JSON.parse(raw) };
  } catch (e) {
    /* ignore corrupt data */
  }
  return emptyDB();
}

/**
 * Data layer for recent colors.
 *
 * Currently backed by localStorage so the app works with zero setup. Older
 * blobs may still carry keys from removed sections (notes, links, POE); they
 * are carried along untouched rather than stripped.
 */
export function useHubData() {
  const [db, setDb] = useState(emptyDB());
  const [ready, setReady] = useState(false);

  const persist = useCallback((next) => {
    setDb(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DB_KEY, JSON.stringify(next));
    }
  }, []);

  useEffect(() => {
    setDb(loadDB());
    setReady(true);
  }, []);

  const addColorToHistory = useCallback(
    (rgb) => {
      const hex = rgbToHex(rgb);
      const next = [{ hex, rgb }, ...(db.colorHistory || []).filter((c) => c.hex !== hex)].slice(
        0,
        MAX_COLOR_HISTORY
      );
      persist({ ...db, colorHistory: next });
    },
    [db, persist]
  );

  return {
    ready,
    // Older saved data predates color history.
    colorHistory: db.colorHistory || [],
    addColorToHistory,
  };
}
