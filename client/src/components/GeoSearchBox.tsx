import React, { useEffect, useRef, useState } from 'react';
import {
  Box, TextField, Paper, CircularProgress, InputAdornment,
} from '@mui/material';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import SearchIcon from '@mui/icons-material/Search';
import LocationOnIcon from '@mui/icons-material/LocationOn';

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

// OpenStreetMap Nominatim search bar — free, no API key. Used by the location
// editor so an admin can drop a pin by typing "Sun City" instead of looking
// up coordinates. Defaults are SA-biased (countrycodes=za, viewbox over the
// country); pass `countrycodes` / `viewbox` to override.
//
// Extracted from LocationEditor.tsx so it can be reused by future flows
// (e.g. the org wizard) without dragging the editor's state along.
interface Props {
  onSelect: (lat: number, lng: number, label: string) => void;
  countrycodes?: string;
  viewbox?: string;
  placeholder?: string;
  label?: string;
}

export function GeoSearchBox({
  onSelect,
  countrycodes = 'za',
  viewbox = '16.3,-34.9,32.9,-22.1',
  placeholder = 'e.g. Rustenburg, Sun City, Sandton...',
  label = 'Search for a place',
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          format: 'json',
          q: query,
          limit: '6',
          countrycodes,
          viewbox,
          bounded: '0',
        });
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?${params}`,
          { headers: { 'Accept-Language': 'en' } },
        );
        const data: NominatimResult[] = await res.json();
        setResults(data);
        setOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [query, countrycodes, viewbox]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (r: NominatimResult) => {
    onSelect(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
    setQuery(r.display_name.split(',').slice(0, 2).join(','));
    setOpen(false);
    setResults([]);
  };

  return (
    <Box ref={containerRef} sx={{ position: 'relative' }}>
      <TextField
        fullWidth
        size="small"
        label={label}
        placeholder={placeholder}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              {loading ? <CircularProgress size={16} /> : <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />}
            </InputAdornment>
          ),
        }}
      />
      {open && results.length > 0 && (
        <Paper
          elevation={8}
          sx={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            zIndex: 9999, maxHeight: 240, overflowY: 'auto', mt: 0.5,
            border: '1px solid rgba(255,255,255,0.12)',
          }}
        >
          <List dense disablePadding>
            {results.map(r => (
              <ListItemButton
                key={r.place_id}
                onClick={() => handleSelect(r)}
                sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', '&:last-child': { borderBottom: 'none' } }}
              >
                <LocationOnIcon sx={{ fontSize: 16, color: 'primary.main', mr: 1, flexShrink: 0 }} />
                <ListItemText
                  primary={r.display_name.split(',').slice(0, 2).join(',')}
                  secondary={r.display_name.split(',').slice(2, 4).join(',').trim() || undefined}
                  primaryTypographyProps={{ fontSize: 13 }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  );
}
