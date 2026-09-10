import { useEffect, useState } from 'react'
import { rawApi } from '../api/rawClient.js'
import { formatDateTime } from '../utils/date.js'
import RefreshButton from '../components/RefreshButton.jsx'

export default function Historico() {
  const [users, setUsers] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [rows, setRows] = useState(null)

  function fetchUsers() {
    return rawApi.listHistoryUsers().then(setUsers).catch((e) => setError(e.message))
  }

  useEffect(() => {
    fetchUsers()
  }, [])

  function selectUser(u) {
    setSelected(u)
    setRows(null)
    rawApi.getHistoryDetail(u.id).then(setRows)
  }

  function refreshAll() {
    return Promise.all([fetchUsers(), selected ? rawApi.getHistoryDetail(selected.id).then(setRows) : null])
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Histórico de buscas</h2>
          <p className="text-sm text-[var(--text-muted)]">Quem buscou o quê nas ferramentas de Buscar Fornecedor e Espionar Loja.</p>
        </div>
        <RefreshButton onRefresh={refreshAll} />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full space-y-2 lg:w-72 lg:shrink-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Usuários</h3>
          {users === null && <p className="text-sm text-[var(--text-muted)]">Carregando…</p>}
          {users?.length === 0 && <p className="text-sm text-[var(--text-muted)]">Nenhuma busca registrada ainda.</p>}
          {users?.map((u) => (
            <button
              key={u.id}
              onClick={() => selectUser(u)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors ${
                selected?.id === u.id
                  ? 'border-brand-500 bg-brand-600/10'
                  : 'border-[var(--border)] bg-[var(--bg-surface)] hover:bg-[var(--hover-surface)]'
              }`}
            >
              <span className="text-[var(--text-primary)]">{u.name}</span>
              <span className="rounded-full border border-pink-500/35 bg-pink-500/10 px-2 py-0.5 text-[10.5px] font-medium text-pink-400">
                {u.searchCount} buscas
              </span>
            </button>
          ))}
        </div>

        <div className="flex-1">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {selected ? `Buscas de ${selected.name}` : 'Selecione um usuário'}
          </h3>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-surface-2)] text-xs uppercase text-[var(--text-muted)]">
                <tr>
                  <th className="px-3 py-2.5">Domínio</th>
                  <th className="px-3 py-2.5">Ferramenta</th>
                  <th className="px-3 py-2.5">Vezes</th>
                  <th className="px-3 py-2.5">Última busca</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows?.map((row, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.domain}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.tool === 'spy' ? 'Espionar Loja' : 'Buscar Fornecedor'}</td>
                    <td className="px-3 py-2.5 text-[var(--text-secondary)]">{row.count}</td>
                    <td className="px-3 py-2.5 text-xs text-[var(--text-muted)]">{formatDateTime(row.lastAt)}</td>
                  </tr>
                ))}
                {rows?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center text-[var(--text-muted)]">
                      Sem buscas registradas.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
