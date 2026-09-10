import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Heart,
  Hash,
  Image as ImageIcon,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { rawApi } from '../api/rawClient.js'
import EmptyState from '../components/EmptyState.jsx'
import TierBadge from '../components/TierBadge.jsx'
import { formatDateTime } from '../utils/date.js'
import { resizeImageToDataUrl } from '../utils/avatar.js'

function Avatar({ src, name, size = 9 }) {
  const px = size * 4
  if (src) {
    return <img src={src} alt="" className="shrink-0 rounded-full object-cover" style={{ width: px, height: px }} />
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 font-semibold text-white"
      style={{ width: px, height: px, fontSize: px * 0.4 }}
    >
      {name?.[0]?.toUpperCase() || '?'}
    </div>
  )
}

function Comment({ comment }) {
  return (
    <div className="flex gap-2.5 py-2">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          comment.is_ambassador ? 'bg-brand-500 text-white' : 'bg-[var(--bg-surface-2)] text-[var(--text-muted)]'
        }`}
      >
        {comment.author_name?.[0]?.toUpperCase() || '?'}
      </div>
      <div className="flex-1">
        <p className="text-xs font-medium text-[var(--text-primary)]">
          {comment.author_name}
          {comment.is_ambassador && <span className="ml-1.5 rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold text-brand-500">Embaixador</span>}
        </p>
        <p className="mt-0.5 text-sm text-[var(--text-muted)]">{comment.body}</p>
      </div>
    </div>
  )
}

function LikeButton({ post, onToggle }) {
  const [pending, setPending] = useState(false)
  async function handleClick() {
    setPending(true)
    try {
      await onToggle(post.id)
    } finally {
      setPending(false)
    }
  }
  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
        post.liked_by_me ? 'bg-red-500/15 text-red-400' : 'text-[var(--text-muted)] hover:bg-[var(--hover-surface)]'
      }`}
    >
      <Heart size={14} fill={post.liked_by_me ? 'currentColor' : 'none'} />
      {post.like_count > 0 ? post.like_count : 'Curtir'}
    </button>
  )
}

function PostMenu({ post, onEdit, onDelete, onTogglePin }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl">
            <button
              onClick={() => {
                setOpen(false)
                onTogglePin(post.id)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--hover-surface)]"
            >
              <Pin size={13} /> {post.pinned ? 'Desafixar' : 'Fixar no topo'}
            </button>
            <button
              onClick={() => {
                setOpen(false)
                onEdit(post)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--hover-surface)]"
            >
              <Pencil size={13} /> Editar
            </button>
            <button
              onClick={() => {
                setOpen(false)
                onDelete(post.id)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={13} /> Apagar
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function PostEditForm({ post, onSave, onCancel }) {
  const [body, setBody] = useState(post.body)
  const [imageUrl, setImageUrl] = useState(post.image_url)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageUrl(await resizeImageToDataUrl(file, 1200, 0.85))
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave(post.id, body.trim(), imageUrl)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-brand-500 focus:outline-none"
      />
      {imageUrl && <img src={imageUrl} alt="" className="max-h-48 rounded-lg" />}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        <label className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
          Trocar imagem
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
        </label>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
          Cancelar
        </button>
      </div>
    </form>
  )
}

function PostCard({ post, community, isOwner, onComment, onToggleLike, onEdit, onDelete, onTogglePin }) {
  const [commentText, setCommentText] = useState('')
  const [sending, setSending] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showComments, setShowComments] = useState(post.comments.length > 0)

  async function submitComment(e) {
    e.preventDefault()
    if (!commentText.trim()) return
    setSending(true)
    try {
      await onComment(post.id, commentText.trim())
      setCommentText('')
      setShowComments(true)
    } finally {
      setSending(false)
    }
  }

  async function handleSaveEdit(postId, body, imageUrl) {
    await onEdit(postId, body, imageUrl)
    setEditing(false)
  }

  return (
    <div className={`rounded-2xl border bg-[var(--bg-surface)] p-5 ${post.pinned ? 'border-brand-500/40' : 'border-[var(--border)]'}`}>
      {post.pinned && (
        <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-brand-500">
          <Pin size={12} fill="currentColor" /> Fixado
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Avatar src={community.photo_url} name={community.name} />
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {community.name}
              <span className="ml-1.5 rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-semibold text-brand-500 align-middle">Embaixador</span>
            </p>
            <p className="text-xs text-[var(--text-faint)]">{formatDateTime(post.created_at)}</p>
          </div>
        </div>
        {isOwner && !editing && <PostMenu post={post} onEdit={() => setEditing(true)} onDelete={onDelete} onTogglePin={onTogglePin} />}
      </div>

      <div className="mt-3">
        {editing ? (
          <PostEditForm post={post} onSave={handleSaveEdit} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <p className="whitespace-pre-wrap text-sm text-[var(--text-primary)]">{post.body}</p>
            {post.image_url && <img src={post.image_url} alt="" className="mt-3 max-h-96 w-full rounded-xl object-cover" />}
          </>
        )}
      </div>

      {!editing && (
        <>
          <div className="mt-3 flex items-center gap-1 border-t border-[var(--border)] pt-2">
            <LikeButton post={post} onToggle={onToggleLike} />
            <button
              onClick={() => setShowComments((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover-surface)]"
            >
              <MessageCircle size={14} />
              {post.comments.length > 0 ? post.comments.length : 'Comentar'}
            </button>
          </div>

          {showComments && (
            <>
              <div className="divide-y divide-[var(--border)]">
                {post.comments.map((c) => (
                  <Comment key={c.id} comment={c} />
                ))}
              </div>
              <form onSubmit={submitComment} className="mt-2 flex items-center gap-2">
                <input
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  placeholder="Escreva um comentário…"
                  className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || !commentText.trim()}
                  className="rounded-lg bg-brand-600 p-2 text-white hover:bg-brand-700 disabled:opacity-40"
                >
                  <Send size={15} />
                </button>
              </form>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Composer({ communityId, channelId, onPosted, onCollapse }) {
  const [body, setBody] = useState('')
  const [imageUrl, setImageUrl] = useState(null)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setImageUrl(await resizeImageToDataUrl(file, 1200, 0.85))
    } catch (err) {
      setError(err.message)
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!body.trim()) return
    setPosting(true)
    setError(null)
    try {
      await rawApi.createCommunityPost(communityId, channelId, body.trim(), imageUrl)
      setBody('')
      setImageUrl(null)
      if (fileRef.current) fileRef.current.value = ''
      onPosted()
      onCollapse()
    } catch (err) {
      setError(err.message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-brand-500/30 bg-[var(--bg-surface)] p-5">
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Compartilhe uma campanha que vendeu, um teste de produto, uma dica…"
        rows={3}
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
      />
      {imageUrl && (
        <div className="relative mt-2 inline-block">
          <img src={imageUrl} alt="" className="max-h-48 rounded-lg" />
          <button
            type="button"
            onClick={() => {
              setImageUrl(null)
              if (fileRef.current) fileRef.current.value = ''
            }}
            className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <ImageIcon size={16} />
          Adicionar imagem
          <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
        </label>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCollapse} className="rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={posting || !body.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {posting ? 'Publicando…' : 'Publicar'}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </form>
  )
}

function AmbassadorSetup({ onCreated }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [photoUrl, setPhotoUrl] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setPhotoUrl(await resizeImageToDataUrl(file, 400, 0.85))
    } catch (err) {
      setError(err.message)
    }
  }

  async function submit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await rawApi.setupCommunity(name.trim(), photoUrl)
      if (description.trim()) {
        // setup não aceita descrição direto (endpoint de criação só pede nome
        // pra ficar rápido) — grava em seguida com o PATCH normal, já que a
        // comunidade acabou de ser criada.
        const status = await rawApi.getCommunityStatus()
        if (status.ambassadorCommunity) {
          await rawApi.updateCommunity(status.ambassadorCommunity.id, { name: name.trim(), description: description.trim(), photoUrl })
        }
      }
      onCreated()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl border border-brand-500/25 bg-[var(--bg-surface)] p-6">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Criar sua comunidade</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Você é embaixador. Dê um nome pra sua comunidade pra começar a postar conteúdo pros seus membros.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="flex items-center gap-3">
          <label className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-surface-2)] text-[var(--text-faint)] hover:border-brand-500">
            {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={18} />}
            <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
          </label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex: Comunidade Samuel Laviero"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
          />
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descrição da comunidade (opcional)"
          rows={2}
          className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {saving ? 'Criando…' : 'Criar comunidade'}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </div>
  )
}

function Directory({ onJoined }) {
  const [communities, setCommunities] = useState(null)
  const [joiningId, setJoiningId] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    rawApi.listCommunityDirectory().then(setCommunities).catch((e) => setError(e.message))
  }, [])

  async function handleJoin(id) {
    setJoiningId(id)
    setError(null)
    try {
      await rawApi.joinCommunity(id)
      onJoined()
    } catch (err) {
      setError(err.message)
    } finally {
      setJoiningId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Comunidade</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Participe da comunidade de um embaixador pra acompanhar conteúdo exclusivo. Depois de entrar não dá pra
          trocar de comunidade, escolha com calma.
        </p>
      </div>
      {error && <EmptyState title="Não deu pra carregar" subtitle={error} />}
      {communities?.length === 0 && <EmptyState title="Nenhuma comunidade disponível ainda" subtitle="Volte mais tarde." />}
      <div className="grid gap-3 sm:grid-cols-2">
        {(communities || []).map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
            <div className="flex items-center gap-3">
              <Avatar src={c.photo_url} name={c.community_name} size={12} />
              <div>
                <p className="font-semibold text-[var(--text-primary)]">{c.community_name}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  por {c.ambassador_name} · {c.active_member_count} membro{c.active_member_count === 1 ? '' : 's'}
                </p>
                {c.description && <p className="mt-0.5 text-xs text-[var(--text-faint)]">{c.description}</p>}
              </div>
            </div>
            <button
              onClick={() => handleJoin(c.id)}
              disabled={joiningId === c.id}
              className="shrink-0 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {joiningId === c.id ? 'Entrando…' : 'Participar'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function TierProgress({ stats, tiers }) {
  const currentIndex = tiers.findIndex((t) => t.name === stats.tier)
  const current = tiers[currentIndex]
  const next = tiers[currentIndex + 1]
  const remaining = next ? Math.max(0, current.max + 1 - stats.activeMemberCount) : 0
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <TierBadge tier={stats.tier} size="lg" />
          <div>
            <p className="text-lg font-semibold text-[var(--text-primary)]">Nível {current?.label}</p>
            <p className="text-sm text-[var(--text-muted)]">
              {stats.activeMemberCount} membro{stats.activeMemberCount === 1 ? '' : 's'} ativo{stats.activeMemberCount === 1 ? '' : 's'} · você
              recebe {stats.tierPercentage}% da recorrência de todos eles
            </p>
          </div>
        </div>
        {next && (
          <p className="max-w-[180px] text-right text-xs text-[var(--text-muted)]">
            Faltam {remaining} pra chegar em {next.label} ({next.percentage}%)
          </p>
        )}
      </div>
    </div>
  )
}

function CommunityEditPanel({ community, onSaved, onClose }) {
  const [name, setName] = useState(community.name)
  const [description, setDescription] = useState(community.description || '')
  const [photoUrl, setPhotoUrl] = useState(community.photo_url)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      setPhotoUrl(await resizeImageToDataUrl(file, 400, 0.85))
    } catch (err) {
      setError(err.message)
    }
  }

  async function submit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await rawApi.updateCommunity(community.id, { name: name.trim(), description, photoUrl })
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-b border-[var(--border)] p-4">
      <div className="flex items-center gap-3">
        <label className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-surface-2)] text-[var(--text-faint)] hover:border-brand-500">
          {photoUrl ? <img src={photoUrl} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={16} />}
          <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
        </label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-2.5 py-2 text-sm text-[var(--text-primary)] focus:border-brand-500 focus:outline-none"
        />
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Descrição da comunidade (opcional)"
        rows={2}
        className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] px-2.5 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
          Cancelar
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  )
}

function NewChannelForm({ communityId, onCreated }) {
  const [name, setName] = useState('')
  const [groupName, setGroupName] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    try {
      const channel = await rawApi.createCommunityChannel(communityId, name.trim(), groupName.trim())
      setName('')
      setGroupName('')
      setOpen(false)
      onCreated(channel.id)
    } finally {
      setCreating(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]"
      >
        <Plus size={13} /> Novo canal
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-surface-2)] p-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nome do canal"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
      />
      <input
        value={groupName}
        onChange={(e) => setGroupName(e.target.value)}
        placeholder="Categoria (opcional)"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:border-brand-500 focus:outline-none"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="flex-1 rounded-md bg-brand-600 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Criar
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]">
          Cancelar
        </button>
      </div>
    </form>
  )
}

function ChannelSidebar({ community, channels, activeChannelId, isOwner, onSelectChannel, onChannelsChanged, onCommunityUpdated }) {
  const [editing, setEditing] = useState(false)

  async function handleDeleteChannel(channelId) {
    if (!window.confirm('Apagar esse canal? Os posts dele somem junto.')) return
    try {
      await rawApi.deleteCommunityChannel(channelId)
      onChannelsChanged()
    } catch (err) {
      window.alert(err.message)
    }
  }

  // Agrupa por group_name (canais sem categoria caem num grupo "Canais"
  // genérico, sempre por último) — pedido do usuário pra parecer mais com
  // um fórum de verdade, com seções tipo "TOP Fornecedores" na referência.
  const groups = new Map()
  for (const c of channels) {
    const key = c.group_name || 'Canais'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(c)
  }
  const orderedGroups = [...groups.entries()].sort((a, b) => (a[0] === 'Canais' ? 1 : b[0] === 'Canais' ? -1 : 0))

  return (
    <aside className="w-64 shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)]">
      {editing ? (
        <CommunityEditPanel
          community={community}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            onCommunityUpdated()
          }}
        />
      ) : (
        <div className="flex items-center gap-3 border-b border-[var(--border)] p-4">
          <Avatar src={community.photo_url} name={community.name} size={11} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-[var(--text-primary)]">{community.name}</p>
            {community.description && <p className="truncate text-xs text-[var(--text-muted)]">{community.description}</p>}
          </div>
          {isOwner && (
            <button onClick={() => setEditing(true)} className="shrink-0 rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover-surface)]" title="Editar comunidade">
              <Pencil size={14} />
            </button>
          )}
        </div>
      )}

      <nav className="max-h-[60vh] space-y-3 overflow-y-auto p-3">
        {orderedGroups.map(([groupName, groupChannels]) => (
          <div key={groupName}>
            <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{groupName}</p>
            <div className="space-y-0.5">
              {groupChannels.map((c) => (
                <div key={c.id} className="group flex items-center">
                  <button
                    onClick={() => onSelectChannel(c.id)}
                    className={`flex flex-1 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                      c.id === activeChannelId ? 'bg-brand-500/15 font-medium text-brand-500' : 'text-[var(--text-muted)] hover:bg-[var(--hover-surface)]'
                    }`}
                  >
                    <Hash size={13} />
                    {c.name}
                  </button>
                  {isOwner && channels.length > 1 && (
                    <button
                      onClick={() => handleDeleteChannel(c.id)}
                      className="hidden shrink-0 rounded-lg p-1.5 text-[var(--text-faint)] hover:bg-[var(--hover-surface)] hover:text-red-400 group-hover:block"
                      title="Apagar canal"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {isOwner && (
        <div className="border-t border-[var(--border)] p-2">
          <NewChannelForm communityId={community.id} onCreated={(channelId) => onChannelsChanged(channelId)} />
        </div>
      )}
    </aside>
  )
}

function SortDropdown({ sort, onChange }) {
  const [open, setOpen] = useState(false)
  const label = sort === 'likes' ? 'Mais curtidos' : 'Mais recente'
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover-surface)]"
      >
        {label} <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl">
            {[
              { value: 'recent', label: 'Mais recente' },
              { value: 'likes', label: 'Mais curtidos' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setOpen(false)
                  onChange(opt.value)
                }}
                className={`block w-full px-3 py-2 text-left text-xs hover:bg-[var(--hover-surface)] ${
                  sort === opt.value ? 'text-brand-500' : 'text-[var(--text-primary)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function CommunityFeed({ communityId, isOwner, ambassadorStats, tiers, onCommunityRenamed }) {
  const [data, setData] = useState(null)
  const [activeChannelId, setActiveChannelId] = useState(null)
  const [sort, setSort] = useState('recent')
  const [composerOpen, setComposerOpen] = useState(false)
  const [error, setError] = useState(null)

  function load(channelId, sortOverride) {
    return rawApi
      .getCommunity(communityId, { channelId, sort: sortOverride || sort })
      .then((d) => {
        setData(d)
        setActiveChannelId(d.activeChannelId)
      })
      .catch((e) => setError(e.message))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId])

  async function handleComment(postId, body) {
    await rawApi.createCommunityComment(postId, body)
    await load(activeChannelId)
  }

  async function handleToggleLike(postId) {
    await rawApi.toggleCommunityPostLike(postId)
    await load(activeChannelId)
  }

  async function handleEditPost(postId, body, imageUrl) {
    await rawApi.updateCommunityPost(postId, body, imageUrl)
    await load(activeChannelId)
  }

  async function handleDeletePost(postId) {
    if (!window.confirm('Apagar esse post? Os comentários dele somem junto.')) return
    await rawApi.deleteCommunityPost(postId)
    await load(activeChannelId)
  }

  async function handleTogglePin(postId) {
    await rawApi.toggleCommunityPostPin(postId)
    await load(activeChannelId)
  }

  function handleSelectChannel(channelId) {
    setActiveChannelId(channelId)
    setComposerOpen(false)
    load(channelId)
  }

  function handleSortChange(newSort) {
    setSort(newSort)
    load(activeChannelId, newSort)
  }

  if (error) return <EmptyState title="Não deu pra carregar" subtitle={error} />
  if (!data) return null

  const activeChannel = data.channels.find((c) => c.id === activeChannelId)

  return (
    <div className="flex items-start gap-4">
      <ChannelSidebar
        community={data.community}
        channels={data.channels}
        activeChannelId={activeChannelId}
        isOwner={isOwner}
        onSelectChannel={handleSelectChannel}
        onChannelsChanged={(newChannelId) => load(newChannelId || activeChannelId)}
        onCommunityUpdated={() => {
          load(activeChannelId)
          onCommunityRenamed?.()
        }}
      />

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Hash size={16} className="text-[var(--text-faint)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{activeChannel?.name}</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <Users size={13} /> {data.activeMemberCount} membro{data.activeMemberCount === 1 ? '' : 's'}
            </span>
            <SortDropdown sort={sort} onChange={handleSortChange} />
          </div>
        </div>

        {isOwner && ambassadorStats && <TierProgress stats={ambassadorStats} tiers={tiers} />}

        {isOwner &&
          (composerOpen ? (
            <Composer communityId={communityId} channelId={activeChannelId} onPosted={() => load(activeChannelId)} onCollapse={() => setComposerOpen(false)} />
          ) : (
            <button
              onClick={() => setComposerOpen(true)}
              className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] px-5 py-3.5 text-left text-sm text-[var(--text-faint)] hover:border-brand-500/40"
            >
              <Avatar src={data.community.photo_url} name={data.community.name} size={8} />
              Criar uma publicação
              <Plus size={16} className="ml-auto text-[var(--text-muted)]" />
            </button>
          ))}

        {data.posts.length === 0 ? (
          <EmptyState title="Nenhum post ainda nesse canal" subtitle={isOwner ? 'Publique o primeiro post por aqui.' : 'O embaixador ainda não postou nada por aqui.'} />
        ) : (
          <div className="space-y-3">
            {data.posts.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                community={data.community}
                isOwner={isOwner}
                onComment={handleComment}
                onToggleLike={handleToggleLike}
                onEdit={handleEditPost}
                onDelete={handleDeletePost}
                onTogglePin={handleTogglePin}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function Comunidade() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  function load() {
    return rawApi.getCommunityStatus().then(setStatus).catch((e) => setError(e.message))
  }

  useEffect(() => {
    load()
  }, [])

  if (error) return <EmptyState title="Não deu pra carregar" subtitle={error} />
  if (!status) return null

  if (status.isAmbassador && !status.ambassadorCommunity) {
    return (
      <div className="max-w-2xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Comunidade</h2>
          <p className="text-sm text-[var(--text-muted)]">Espaço fechado só pra você e quem está na sua comunidade.</p>
        </div>
        <AmbassadorSetup onCreated={load} />
      </div>
    )
  }

  if (status.isAmbassador && status.ambassadorCommunity) {
    return (
      <CommunityFeed
        communityId={status.ambassadorCommunity.id}
        isOwner
        ambassadorStats={status.ambassadorStats}
        tiers={status.tiers}
        onCommunityRenamed={load}
      />
    )
  }

  if (status.memberCommunityId) {
    return <CommunityFeed communityId={status.memberCommunityId} isOwner={false} tiers={status.tiers} />
  }

  return (
    <div className="max-w-2xl">
      <Directory onJoined={load} />
    </div>
  )
}
