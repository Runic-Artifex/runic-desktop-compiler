export interface Person {
  id: number;
  name: string;
  surname: string;
}

export const display = (p: Person): string => `${p.surname}, ${p.name}`;

/** People whose surname starts with `prefix` (case-insensitive). */
export function matching(people: Person[], prefix: string): Person[] {
  const p = prefix.trim().toLowerCase();
  return people.filter(person => person.surname.toLowerCase().startsWith(p));
}
