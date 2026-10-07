import { useState } from 'react';

interface Row {
  id: number;
  name: string;
  selected: boolean;
}

const initialRows: Row[] = [
  { id: 1, name: 'Alpha', selected: false },
  { id: 2, name: 'Beta', selected: true },
  { id: 3, name: 'Gamma', selected: false },
];

export function App() {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [next, setNext] = useState(4);
  const [lastRow, setLastRow] = useState('-');
  const [saved, setSaved] = useState('-');
  const [stopped, setStopped] = useState('-');
  const [wide, setWide] = useState(false);

  function update(id: number, updateRow: (row: Row) => Row) {
    setRows(rows.map((row) => row.id === id ? updateRow(row) : row));
  }

  function add() {
    setRows([...rows, { id: next, name: 'Added ' + next, selected: false }]);
    setNext(next + 1);
  }

  return (
    <main>
      <div className="controls">
        <button id="add" onClick={add}>Add</button>
        <button id="reverse" onClick={() => setRows(rows.toReversed())}>Reverse</button>
        <button id="toggle-span" onClick={() => setWide(!wide)}>Toggle colspan</button>
      </div>

      <div id="pane" className="pane">
        <table id="table">
          <caption id="caption">Orders ({rows.length})</caption>
          <colgroup><col className="name" /><col className="edit" /><col className="actions" /></colgroup>
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Selected</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr id={'row-' + row.id} key={row.id} onClick={() => setLastRow(String(row.id))}>
                <td><input id={'name-' + row.id} aria-label={'Name ' + row.id} value={row.name} onChange={(event) => update(row.id, (current) => ({ ...current, name: event.target.value }))} /></td>
                <td><input id={'selected-' + row.id} aria-label={'Selected ' + row.id} type="checkbox" checked={row.selected} onChange={(event) => update(row.id, (current) => ({ ...current, selected: event.target.checked }))} /></td>
                <td>
                  <button id={'save-' + row.id} onClick={() => setSaved(String(row.id))}>Save</button>
                  <button id={'stop-' + row.id} onClick={(event) => { event.stopPropagation(); setStopped(String(row.id)); }}>Stop</button>
                  <button id={'remove-' + row.id} onClick={() => setRows(rows.filter((current) => current.id !== row.id))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr id="span-row">
              <td id="span" colSpan={wide ? 2 : 1}>Span {wide ? 'wide' : 'narrow'}</td>
              {!wide && <td>Detail</td>}
              <td>{rows.length} rows</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p id="state">row={lastRow} save={saved} stop={stopped} selected={rows.filter((row) => row.selected).length}</p>
    </main>
  );
}
