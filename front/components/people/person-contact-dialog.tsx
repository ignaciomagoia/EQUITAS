'use client'

import { ArrowLeft, ExternalLink, Mail, MessageCircle, Phone, Smartphone, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { badgeVariants } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAuthState } from '@/components/auth/auth-provider'
import { cn, formatCurrency } from '@/lib/utils'
import type { PersonContactItem } from '@/types/equitas-domain'

type PersonContactDialogProps = {
  personId: string
  personName: string
  contacts: PersonContactItem[]
  totalDebtAssociated: number
  debtorIdentifiers: string[]
}

type CommunicationChannel = 'whatsapp' | 'email'

type PreparedCommunication = {
  channel: CommunicationChannel
  contact: PersonContactItem
}

type CommunicationMessageData = Pick<
  PersonContactDialogProps,
  'personName' | 'totalDebtAssociated' | 'debtorIdentifiers'
> & {
  institutionName?: string
}

type CopyTarget = 'subject' | 'message' | 'telegram'

function ContactIcon({ channel }: { channel: string }) {
  if (channel === 'Email') {
    return <Mail className="size-4 text-[#163a63]" aria-hidden />
  }

  if (channel === 'Celular') {
    return <Smartphone className="size-4 text-[#163a63]" aria-hidden />
  }

  return <Phone className="size-4 text-[#163a63]" aria-hidden />
}

function getContactHref(contact: PersonContactItem) {
  if (contact.channel === 'Telefono' || contact.channel === 'Celular') {
    return `tel:${contact.value}`
  }

  return null
}

function normalizeWhatsAppRecipient(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^00/, '').replace(/^0+/, '')

  if (digits.length < 8) {
    return null
  }

  if (digits.startsWith('549')) {
    return digits
  }

  if (digits.startsWith('54')) {
    return `549${digits.slice(2)}`
  }

  return `549${digits}`
}

function buildDebtorSummary(debtorIdentifiers: string[], institutionName?: string) {
  const visibleDebtors = debtorIdentifiers.slice(0, 3)

  if (visibleDebtors.length === 0) {
    return institutionName ? 'sus obligaciones registradas' : 'sus obligaciones municipales'
  }

  return (
    visibleDebtors.join(', ') +
    (debtorIdentifiers.length > visibleDebtors.length
      ? ` y ${debtorIdentifiers.length - visibleDebtors.length} mas`
      : '')
  )
}

function buildTelegramInvitation(url: string) {
  return `Para consultar sus obligaciones por Telegram, ingrese aqui: ${url}`
}

export function buildWhatsAppMessage({
  personName,
  totalDebtAssociated,
  debtorIdentifiers,
  institutionName,
}: CommunicationMessageData) {
  const institutionReference = institutionName?.trim() || 'la municipalidad'

  return [
    `Hola ${personName}.`,
    '',
    `Le informamos que registra un saldo pendiente asociado a ${buildDebtorSummary(debtorIdentifiers, institutionName)}.`,
    `Saldo total informado: ${formatCurrency(totalDebtAssociated)}.`,
    '',
    `Esta comunicacion es informativa. Para consultar el detalle o las alternativas de regularizacion, comuniquese con ${institutionReference}.`,
  ].join('\n')
}

export function buildWhatsAppUrl(recipient: string, message: string) {
  const normalizedRecipient = normalizeWhatsAppRecipient(recipient)

  if (!normalizedRecipient) {
    return null
  }

  return `https://wa.me/${normalizedRecipient}?text=${encodeURIComponent(message)}`
}

export function buildEmailSubject(institutionName?: string) {
  const normalizedInstitutionName = institutionName?.trim()

  return normalizedInstitutionName
    ? `Aviso informativo sobre obligaciones - ${normalizedInstitutionName}`
    : 'Aviso informativo sobre obligaciones municipales'
}

export function buildEmailMessage({
  personName,
  totalDebtAssociated,
  debtorIdentifiers,
  institutionName,
}: CommunicationMessageData) {
  const institutionReference = institutionName?.trim() || 'la municipalidad'
  const signature = institutionName?.trim() || 'Municipalidad'

  return [
    `Hola ${personName},`,
    '',
    `Le informamos que registra un saldo pendiente asociado a ${buildDebtorSummary(debtorIdentifiers, institutionName)}.`,
    `Saldo total informado: ${formatCurrency(totalDebtAssociated)}.`,
    '',
    `Esta comunicacion es informativa. Para consultar el detalle o las alternativas de regularizacion, comuniquese con ${institutionReference}.`,
    '',
    signature,
  ].join('\n')
}

export function buildMailtoUrl(recipient: string, subject: string, message: string) {
  const normalizedRecipient = recipient.trim()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedRecipient)) {
    return null
  }

  return `mailto:${normalizedRecipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`
}

export function PersonContactDialog({
  personId,
  personName,
  contacts,
  totalDebtAssociated,
  debtorIdentifiers,
}: PersonContactDialogProps) {
  const { source, tenant } = useAuthState()
  const [isOpen, setIsOpen] = useState(false)
  const [preparedCommunication, setPreparedCommunication] = useState<PreparedCommunication | null>(null)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [telegramLink, setTelegramLink] = useState<string | null>(null)
  const [isGeneratingTelegramLink, setIsGeneratingTelegramLink] = useState(false)
  const [telegramLinkError, setTelegramLinkError] = useState<string | null>(null)
  const [copiedTarget, setCopiedTarget] = useState<CopyTarget | null>(null)
  const [copyError, setCopyError] = useState(false)
  const titleId = useId()
  const institutionName = source === 'multi' ? tenant?.name : undefined
  const isTelegramAvailable = source === 'legacy'

  const closeDialog = () => {
    setPreparedCommunication(null)
    setCopiedTarget(null)
    setCopyError(false)
    setTelegramLink(null)
    setTelegramLinkError(null)
    setIsOpen(false)
  }

  const prepareCommunication = (channel: CommunicationChannel, contact: PersonContactItem) => {
    const communicationData = {
      personName,
      totalDebtAssociated,
      debtorIdentifiers,
      institutionName,
    }

    setPreparedCommunication({ channel, contact })
    setCopiedTarget(null)
    setCopyError(false)
    setTelegramLinkError(null)
    const baseMessage =
      channel === 'whatsapp'
        ? buildWhatsAppMessage(communicationData)
        : buildEmailMessage(communicationData)

    setMessage(
      isTelegramAvailable && telegramLink
        ? `${baseMessage}\n\n${buildTelegramInvitation(telegramLink)}`
        : baseMessage
    )
    setSubject(channel === 'email' ? buildEmailSubject(institutionName) : '')
  }

  const addTelegramLink = async () => {
    if (telegramLink || isGeneratingTelegramLink) {
      return
    }

    setIsGeneratingTelegramLink(true)
    setTelegramLinkError(null)

    try {
      const response = await fetch('/api/telegram/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId }),
      })
      const payload = (await response.json()) as { url?: string; error?: string }

      if (!response.ok || !payload.url) {
        throw new Error(payload.error ?? 'No se pudo generar el enlace de Telegram.')
      }

      const invitation = buildTelegramInvitation(payload.url)
      setTelegramLink(payload.url)
      setMessage((currentMessage) =>
        currentMessage.includes(payload.url as string)
          ? currentMessage
          : `${currentMessage}\n\n${invitation}`
      )
    } catch (error) {
      setTelegramLinkError(
        error instanceof Error ? error.message : 'No se pudo generar el enlace de Telegram.'
      )
    } finally {
      setIsGeneratingTelegramLink(false)
    }
  }

  const copyDraftValue = async (target: CopyTarget, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedTarget(target)
      setCopyError(false)
    } catch {
      setCopiedTarget(null)
      setCopyError(true)
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }

      if (preparedCommunication) {
        setPreparedCommunication(null)
      } else {
        closeDialog()
      }
    }

    document.addEventListener('keydown', closeOnEscape)

    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isOpen, preparedCommunication])

  const communicationUrl =
    preparedCommunication?.channel === 'whatsapp'
      ? buildWhatsAppUrl(preparedCommunication.contact.value, message)
      : preparedCommunication?.channel === 'email'
        ? buildMailtoUrl(preparedCommunication.contact.value, subject, message)
        : null

  return (
    <>
      <button
        type="button"
        className={cn(
          badgeVariants({ variant: 'success' }),
          'cursor-pointer hover:bg-[#dcefe4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#163a63] focus-visible:ring-offset-2'
        )}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
      >
        Disponible
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDialog()
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-lg border border-[#d2dceb] bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id={titleId} className="text-base font-semibold text-[#163a63]">
                  {preparedCommunication?.channel === 'whatsapp'
                    ? 'Preparar mensaje de WhatsApp'
                    : preparedCommunication?.channel === 'email'
                      ? 'Preparar correo electronico'
                      : 'Contacto disponible'}
                </h2>
                <p className="mt-1 text-sm text-slate-600">{personName}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Cerrar contactos"
                onClick={closeDialog}
              >
                <X className="size-4" />
              </Button>
            </div>

            {preparedCommunication ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-md border border-[#b7ddca] bg-[#edf6f1] px-3 py-2 text-sm text-slate-700">
                  <span className="font-semibold text-[#255a43]">Destinatario: </span>
                  {preparedCommunication.contact.value}
                </div>

                {preparedCommunication.channel === 'email' && (
                  <div>
                    <label className="block text-sm font-medium text-slate-800" htmlFor={`${titleId}-subject`}>
                      Asunto
                    </label>
                    <input
                      id={`${titleId}-subject`}
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-[#163a63] focus:ring-2 focus:ring-[#163a63]/20"
                    />
                  </div>
                )}

                <label className="block text-sm font-medium text-slate-800" htmlFor={`${titleId}-message`}>
                  {preparedCommunication.channel === 'email' ? 'Cuerpo del correo' : 'Mensaje a enviar'}
                </label>
                <textarea
                  id={`${titleId}-message`}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-[#163a63] focus:ring-2 focus:ring-[#163a63]/20"
                />
                {isTelegramAvailable && (
                <div className="rounded-md border border-[#cfdaea] bg-[#edf2f9] p-3">
                  <p className="text-sm font-medium text-[#163a63]">Asistente de Telegram</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Genera un enlace personal y temporal. El enlace se agrega al borrador actual.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isGeneratingTelegramLink || Boolean(telegramLink)}
                      onClick={addTelegramLink}
                    >
                      <MessageCircle className="size-3.5" />
                      {isGeneratingTelegramLink
                        ? 'Generando enlace...'
                        : telegramLink
                          ? 'Enlace agregado'
                          : 'Agregar enlace de Telegram'}
                    </Button>
                    {telegramLink && (
                      <a
                        href={telegramLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-[#163a63] transition hover:bg-slate-50"
                      >
                        Probar bot
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                  {telegramLinkError && (
                    <p className="mt-2 text-xs text-[#8f3434]">{telegramLinkError}</p>
                  )}
                </div>
                )}
                {preparedCommunication.channel === 'email' && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyDraftValue('subject', subject)}
                    >
                      {copiedTarget === 'subject' ? 'Asunto copiado' : 'Copiar asunto'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyDraftValue('message', message)}
                    >
                      {copiedTarget === 'message' ? 'Cuerpo copiado' : 'Copiar cuerpo'}
                    </Button>
                    {copyError && (
                      <p className="self-center text-xs text-[#8f3434]">
                        No se pudo copiar automaticamente. Seleccione el texto y copie manualmente.
                      </p>
                    )}
                  </div>
                )}
                <p className="text-xs text-slate-600">
                  {preparedCommunication.channel === 'email'
                    ? 'El cliente de correo se abrira con el borrador cargado. Si no completa asunto o cuerpo, copielos antes y pegue los manualmente.'
                    : 'WhatsApp se abrira en una pestana nueva. Revise el mensaje y envie de forma manual.'}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setPreparedCommunication(null)}>
                    <ArrowLeft className="size-3.5" />
                    Volver
                  </Button>
                  {communicationUrl ? (
                    <a
                      href={communicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-[#163a63] px-3 text-xs font-medium text-white transition hover:bg-[#1c4c82] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#163a63] focus-visible:ring-offset-2"
                    >
                      {preparedCommunication.channel === 'email' ? (
                        <Mail className="size-3.5" />
                      ) : (
                        <MessageCircle className="size-3.5" />
                      )}
                      {preparedCommunication.channel === 'email' ? 'Abrir correo' : 'Abrir WhatsApp'}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    <p className="text-xs text-[#8f3434]">
                      {preparedCommunication.channel === 'email'
                        ? 'El email no tiene un formato valido.'
                        : 'El celular no tiene un formato valido para WhatsApp.'}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <ul className="space-y-2">
                  {contacts.map((contact) => {
                  const href = contact.channel === 'Email' ? null : getContactHref(contact)
                  const content = (
                    <>
                      <ContactIcon channel={contact.channel} />
                      <span className="font-medium text-slate-800">{contact.channel}</span>
                      <span className="ml-auto break-all text-right text-[#163a63]">{contact.value}</span>
                    </>
                  )

                  return (
                    <li key={`${contact.channel}-${contact.value}`}>
                      <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                        {href ? (
                          <a
                            href={href}
                            className="flex min-w-0 flex-1 items-center gap-2 hover:text-[#163a63] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#163a63]"
                          >
                            {content}
                          </a>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>
                        )}
                        {['Celular', 'Telefono'].includes(contact.channel) && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => prepareCommunication('whatsapp', contact)}
                          >
                            <MessageCircle className="size-3.5" />
                            WhatsApp
                          </Button>
                        )}
                        {contact.channel === 'Email' && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => prepareCommunication('email', contact)}
                          >
                            <Mail className="size-3.5" />
                            Correo
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                  })}
                </ul>
                {isTelegramAvailable && (
                <div className="rounded-md border border-[#cfdaea] bg-[#edf2f9] p-3">
                  <p className="text-sm font-medium text-[#163a63]">Asistente de Telegram</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Genera un enlace personal y temporal. Luego puede copiarlo o agregarlo al
                    mensaje de WhatsApp o correo.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isGeneratingTelegramLink || Boolean(telegramLink)}
                      onClick={addTelegramLink}
                    >
                      <MessageCircle className="size-3.5" />
                      {isGeneratingTelegramLink
                        ? 'Generando enlace...'
                        : telegramLink
                          ? 'Enlace generado'
                          : 'Generar enlace de Telegram'}
                    </Button>
                    {telegramLink && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => copyDraftValue('telegram', telegramLink)}
                        >
                          {copiedTarget === 'telegram' ? 'Enlace copiado' : 'Copiar enlace'}
                        </Button>
                        <a
                          href={telegramLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-[#163a63] transition hover:bg-slate-50"
                        >
                          Probar bot
                          <ExternalLink className="size-3.5" />
                        </a>
                      </>
                    )}
                  </div>
                  {telegramLinkError && (
                    <p className="mt-2 text-xs text-[#8f3434]">{telegramLinkError}</p>
                  )}
                </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
