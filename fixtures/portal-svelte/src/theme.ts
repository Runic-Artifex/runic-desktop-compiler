import { Context } from 'runed';

/** A context the app sets and portalled content reads (through getAllContexts). */
export const ThemeContext = new Context<string>('Theme');
