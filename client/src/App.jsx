import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import {
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Download,
  Mail,
  Menu,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? ""
    : "http://localhost:4000");

const INBOX_LIFETIME_MINUTES = 15;

function formatDate(value) {
  if (!value) return "Unknown time";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatTime(value) {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getMessageSubject(message) {
  return (
    message?.subject?.trim() ||
    "(No subject)"
  );
}

function getMessageSender(message) {
  return (
    message?.from ||
    message?.sender ||
    message?.mailFrom ||
    "Unknown sender"
  );
}

function getMessageRecipient(message) {
  return (
    message?.to ||
    message?.recipient ||
    message?.rcptTo ||
    ""
  );
}

function getMessageBody(message) {
  if (!message) return "";

  if (
    typeof message.body === "string" &&
    message.body.trim()
  ) {
    return message.body;
  }

  if (
    typeof message.text === "string" &&
    message.text.trim()
  ) {
    return message.text;
  }

  return "This email does not contain a text message.";
}

function getMessageHtml(message) {
  if (!message) return "";

  if (
    typeof message.html === "string" &&
    message.html.trim()
  ) {
    return message.html;
  }

  return "";
}

function App() {
  const [inbox, setInbox] = useState(null);

  const [messages, setMessages] = useState([]);

  const [loadingInbox, setLoadingInbox] =
    useState(true);

  const [loadingMessages, setLoadingMessages] =
    useState(false);

  const [error, setError] = useState("");

  const [copyStatus, setCopyStatus] =
    useState(false);

  const [remainingSeconds, setRemainingSeconds] =
    useState(INBOX_LIFETIME_MINUTES * 60);

  const [selectedMessage, setSelectedMessage] =
    useState(null);

  const [deletingMessage, setDeletingMessage] =
    useState(false);

  const [mobileMenuOpen, setMobileMenuOpen] =
    useState(false);

  /*
   * Keep the selected message in a ref as well.
   *
   * This prevents the automatic refresh timer from
   * being recreated every time the user opens/closes
   * an email.
   */
  const selectedMessageRef =
    useRef(null);

  /*
   * Prevent overlapping refresh requests.
   *
   * Example:
   * - background refresh starts
   * - user clicks Refresh immediately
   * - second request is ignored
   */
  const refreshInFlightRef =
    useRef(false);

  /*
   * Prevent the expiry handler from running
   * repeatedly every second after expiry.
   */
  const expiryHandledRef =
    useRef(false);

  /*
   * Prevent accidental double-clicks from creating
   * multiple temporary inboxes.
   */
  const createInFlightRef =
    useRef(false);

  useEffect(() => {
    selectedMessageRef.current =
      selectedMessage;
  }, [selectedMessage]);

  /*
   * CREATE INBOX
   */
  const createInbox = useCallback(
    async () => {
      if (createInFlightRef.current) {
        return;
      }

      createInFlightRef.current = true;

      try {
        setLoadingInbox(true);
        setError("");

        setSelectedMessage(null);
        selectedMessageRef.current = null;

        setMessages([]);

        setCopyStatus(false);

        expiryHandledRef.current = false;

        refreshInFlightRef.current = false;

        const response = await fetch(
          `${API_BASE}/api/inboxes`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/json"
            }
          }
        );

        if (!response.ok) {
          throw new Error(
            "Unable to create a temporary inbox."
          );
        }

        const data =
          await response.json();

        const rawInbox =
          data?.inbox ||
          data?.data ||
          data;

        const normalizedInbox = {
          ...rawInbox,

          id:
            rawInbox?.id ||
            rawInbox?.inboxId ||
            rawInbox?._id,

          address:
            rawInbox?.address ||
            rawInbox?.email ||
            rawInbox?.emailAddress,

          expiresAt:
            rawInbox?.expiresAt ||
            rawInbox?.expiry ||
            rawInbox?.expires ||
            rawInbox?.expiration
        };

        if (!normalizedInbox.address) {
          throw new Error(
            "The server created the inbox but did not return an email address."
          );
        }

        setInbox(normalizedInbox);

        const expiresAt =
          normalizedInbox.expiresAt
            ? new Date(
                normalizedInbox.expiresAt
              ).getTime()
            : Date.now() +
              INBOX_LIFETIME_MINUTES *
                60 *
                1000;

        setRemainingSeconds(
          Math.max(
            0,
            Math.floor(
              (expiresAt -
                Date.now()) /
                1000
            )
          )
        );
      } catch (err) {
        console.error(err);

        setError(
          err.message ||
            "Something went wrong while creating the inbox."
        );
      } finally {
        setLoadingInbox(false);

        createInFlightRef.current = false;
      }
    },
    []
  );

  /*
   * LOAD MESSAGES
   *
   * This function intentionally does not depend
   * on selectedMessage.
   */
  const loadMessages = useCallback(
    async (showLoading = true) => {
      if (!inbox?.id) {
        return;
      }

      /*
       * Do not send requests after the inbox has
       * already expired.
       */
      const inboxExpiry =
        inbox.expiresAt
          ? new Date(
              inbox.expiresAt
            ).getTime()
          : 0;

      if (
        inboxExpiry &&
        inboxExpiry <= Date.now()
      ) {
        return;
      }

      /*
       * Prevent overlapping requests.
       */
      if (refreshInFlightRef.current) {
        return;
      }

      refreshInFlightRef.current = true;

      try {
        if (showLoading) {
          setLoadingMessages(true);
        }

        const response = await fetch(
          `${API_BASE}/api/inboxes/${inbox.id}/messages`
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(
              "This temporary inbox has expired."
            );
          }

          throw new Error(
            "Unable to load messages."
          );
        }

        const data =
          await response.json();

        const receivedMessages =
          Array.isArray(data)
            ? data
            : Array.isArray(
                data?.messages
              )
            ? data.messages
            : [];

        setMessages(
          receivedMessages
        );

        /*
         * If an email is currently open,
         * update the reader with the latest
         * version of that message.
         */
        const currentlySelected =
          selectedMessageRef.current;

        if (currentlySelected) {
          const updated =
            receivedMessages.find(
              (message) =>
                String(
                  message.id
                ) ===
                String(
                  currentlySelected.id
                )
            );

          if (updated) {
            setSelectedMessage(
              updated
            );

            selectedMessageRef.current =
              updated;
          }
        }

        /*
         * Successful refresh means the old
         * loading error is no longer relevant.
         */
        setError("");
      } catch (err) {
        console.error(err);

        setError(
          err.message ||
            "Unable to load inbox."
        );
      } finally {
        setLoadingMessages(false);

        refreshInFlightRef.current =
          false;
      }
    },
    [inbox?.id]
  );

  /*
   * FIRST INBOX
   */
  useEffect(() => {
    createInbox();
  }, [createInbox]);

  /*
   * EXPIRY TIMER
   */
  useEffect(() => {
    if (!inbox?.expiresAt) {
      return;
    }

    const updateTimer = () => {
      const expiresAt =
        new Date(
          inbox.expiresAt
        ).getTime();

      const seconds =
        Math.max(
          0,
          Math.floor(
            (expiresAt -
              Date.now()) /
              1000
          )
        );

      setRemainingSeconds(
        seconds
      );

      if (
        seconds === 0 &&
        !expiryHandledRef.current
      ) {
        expiryHandledRef.current =
          true;

        refreshInFlightRef.current =
          false;

        setMessages([]);

        setSelectedMessage(null);

        selectedMessageRef.current =
          null;

        setError(
          "This temporary inbox has expired. Create a new address to continue."
        );
      }
    };

    updateTimer();

    const timer =
      setInterval(
        updateTimer,
        1000
      );

    return () =>
      clearInterval(timer);
  }, [inbox?.expiresAt]);

  /*
   * AUTO REFRESH EVERY 5 SECONDS
   *
   * The refresh guard prevents overlapping
   * background requests.
   */
  useEffect(() => {
    if (!inbox?.id) {
      return;
    }

    loadMessages();

    const refreshTimer =
      setInterval(() => {
        loadMessages(false);
      }, 5000);

    return () =>
      clearInterval(
        refreshTimer
      );
  }, [
    inbox?.id,
    loadMessages
  ]);

  /*
   * FORMATTED EXPIRY
   */
  const formattedRemaining =
    useMemo(() => {
      const minutes =
        Math.floor(
          remainingSeconds /
            60
        );

      const seconds =
        remainingSeconds % 60;

      return `${String(
        minutes
      ).padStart(
        2,
        "0"
      )}:${String(
        seconds
      ).padStart(
        2,
        "0"
      )}`;
    }, [remainingSeconds]);

  /*
   * COPY ADDRESS
   */
  const copyAddress =
    async () => {
      if (!inbox?.address) {
        return;
      }

      if (remainingSeconds <= 0) {
        setError(
          "This temporary inbox has expired."
        );

        return;
      }

      try {
        await navigator.clipboard.writeText(
          inbox.address
        );

        setCopyStatus(true);

        setTimeout(() => {
          setCopyStatus(false);
        }, 1800);
      } catch (err) {
        console.error(err);

        setError(
          "Unable to copy the email address."
        );
      }
    };

  /*
   * DELETE INBOX
   */
  const deleteInbox =
    async () => {
      if (!inbox?.id) {
        return;
      }

      const confirmed =
        window.confirm(
          "Delete this temporary inbox and all of its messages?"
        );

      if (!confirmed) {
        return;
      }

      try {
        setError("");

        const response =
          await fetch(
            `${API_BASE}/api/inboxes/${inbox.id}`,
            {
              method: "DELETE"
            }
          );

        if (!response.ok) {
          throw new Error(
            "Unable to delete the inbox."
          );
        }

        await createInbox();
      } catch (err) {
        console.error(err);

        setError(
          err.message ||
            "Unable to delete inbox."
        );
      }
    };

  /*
   * OPEN MESSAGE + MARK READ
   */
  const openMessage =
    async (message) => {
      if (!message) {
        return;
      }

      /*
       * Open immediately so the UI does not
       * wait for the server.
       */
      setSelectedMessage(
        message
      );

      selectedMessageRef.current =
        message;

      setMobileMenuOpen(
        false
      );

      /*
       * Already read = nothing else needed.
       */
      if (
        message.isRead ||
        !message.id ||
        !inbox?.id
      ) {
        return;
      }

      try {
        const response =
          await fetch(
            `${API_BASE}/api/inboxes/${inbox.id}/messages/${message.id}/read`,
            {
              method: "PATCH"
            }
          );

        if (response.ok) {
          setMessages(
            (current) =>
              current.map(
                (item) =>
                  String(item.id) ===
                  String(message.id)
                    ? {
                        ...item,
                        isRead: true
                      }
                    : item
              )
          );

          setSelectedMessage(
            (current) =>
              current
                ? {
                    ...current,
                    isRead: true
                  }
                : current
          );

          selectedMessageRef.current =
            {
              ...message,
              isRead: true
            };
        }
      } catch (err) {
        console.error(
          "Mark read error:",
          err
        );
      }
    };

  /*
   * BACK TO INBOX
   */
  const handleBackToInbox =
    () => {
      setSelectedMessage(
        null
      );

      selectedMessageRef.current =
        null;

      setDeletingMessage(
        false
      );

      setError("");

      setMobileMenuOpen(
        false
      );

      loadMessages(false);
    };

  /*
   * DELETE SINGLE MESSAGE
   */
  const deleteMessage =
    async () => {
      if (
        !inbox?.id ||
        !selectedMessage?.id
      ) {
        return;
      }

      const confirmed =
        window.confirm(
          "Delete this email?"
        );

      if (!confirmed) {
        return;
      }

      try {
        setDeletingMessage(
          true
        );

        setError("");

        const response =
          await fetch(
            `${API_BASE}/api/inboxes/${inbox.id}/messages/${selectedMessage.id}`,
            {
              method: "DELETE"
            }
          );

        if (!response.ok) {
          throw new Error(
            "Unable to delete this email."
          );
        }

        setMessages(
          (current) =>
            current.filter(
              (message) =>
                String(message.id) !==
                String(
                  selectedMessage.id
                )
            )
        );

        setSelectedMessage(
          null
        );

        selectedMessageRef.current =
          null;
      } catch (err) {
        console.error(err);

        setError(
          err.message ||
            "Unable to delete email."
        );
      } finally {
        setDeletingMessage(
          false
        );
      }
    };

  const isExpired =
    remainingSeconds <= 0;

  const unreadCount =
    messages.filter(
      (message) =>
        !message.isRead
    ).length;

  /*
   * INITIAL LOADING
   */
  if (loadingInbox) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />

        <p>
          Creating your temporary inbox...
        </p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* HEADER */}

      <header className="site-header">
        <div className="header-inner">
          <button
            className="brand"
            onClick={
              handleBackToInbox
            }
            type="button"
          >
            <span className="brand-icon">
              <Mail size={18} />
            </span>

            <span>
              Temp Mail
            </span>
          </button>

          <nav
            className={`main-nav ${
              mobileMenuOpen
                ? "main-nav-open"
                : ""
            }`}
          >
            <a
              href="#how-it-works"
              onClick={() =>
                setMobileMenuOpen(
                  false
                )
              }
            >
              How it works
            </a>

            <a
              href="#privacy"
              onClick={() =>
                setMobileMenuOpen(
                  false
                )
              }
            >
              Privacy
            </a>

            <button
              type="button"
              className="nav-new-button"
              onClick={() => {
                setMobileMenuOpen(
                  false
                );

                createInbox();
              }}
              disabled={
                createInFlightRef.current
              }
            >
              New address
            </button>
          </nav>

          <button
            className="mobile-menu-button"
            type="button"
            onClick={() =>
              setMobileMenuOpen(
                (value) =>
                  !value
              )
            }
            aria-label="Open menu"
          >
            {mobileMenuOpen ? (
              <X size={20} />
            ) : (
              <Menu size={20} />
            )}
          </button>
        </div>
      </header>

      <main className="main-content">
        {!selectedMessage ? (
          <>
            {/* HERO */}

            <section className="hero-section">
              <div className="hero-copy">
                <span className="eyebrow">
                  <ShieldCheck
                    size={15}
                  />

                  Private by default
                </span>

                <h1>
                  A temporary inbox,
                  <br />
                  without the clutter.
                </h1>

                <p>
                  Receive emails
                  instantly without
                  giving away your
                  personal email
                  address.
                </p>
              </div>

              <div className="address-card">
                <div className="address-card-top">
                  <span className="address-label">
                    Your temporary
                    address
                  </span>

                  <span
                    className={`expiry-badge ${
                      isExpired
                        ? "expired"
                        : ""
                    }`}
                  >
                    <Clock3
                      size={14}
                    />

                    {isExpired
                      ? "Expired"
                      : `Expires in ${formattedRemaining}`}
                  </span>
                </div>

                <div className="address-row">
                  <div className="address-text">
                    {inbox?.address ||
                      "Generating address..."}
                  </div>

                  <button
                    className="copy-button"
                    type="button"
                    onClick={
                      copyAddress
                    }
                    disabled={
                      !inbox?.address ||
                      isExpired
                    }
                  >
                    {copyStatus ? (
                      <>
                        <Check
                          size={17}
                        />

                        Copied
                      </>
                    ) : (
                      <>
                        <Copy
                          size={17}
                        />

                        Copy
                      </>
                    )}
                  </button>
                </div>
              </div>
            </section>

            {/* ERROR */}

            {error && (
              <div className="error-banner">
                <span>
                  {error}
                </span>

                {!isExpired && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      loadMessages()
                    }
                    disabled={
                      loadingMessages
                    }
                  >
                    Retry
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    setError("")
                  }
                  aria-label="Close error"
                >
                  <X size={16} />
                </button>
              </div>
            )}

            {/* INBOX */}

            <section className="inbox-section">
              <div className="section-heading">
                <div>
                  <span className="section-kicker">
                    Inbox
                  </span>

                  <h2>
                    {messages.length}{" "}
                    {messages.length ===
                    1
                      ? "message"
                      : "messages"}

                    {unreadCount >
                      0 && (
                      <span className="unread-count">
                        {unreadCount}{" "}
                        unread
                      </span>
                    )}
                  </h2>
                </div>

                <div className="inbox-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      loadMessages()
                    }
                    disabled={
                      loadingMessages ||
                      isExpired
                    }
                  >
                    <RefreshCw
                      size={16}
                      className={
                        loadingMessages
                          ? "spin-icon"
                          : ""
                      }
                    />

                    Refresh
                  </button>

                  <button
                    type="button"
                    className="danger-button"
                    onClick={
                      deleteInbox
                    }
                    disabled={
                      deletingMessage
                    }
                  >
                    <Trash2
                      size={16}
                    />

                    Delete
                  </button>
                </div>
              </div>

              <div className="inbox-card">
                {loadingMessages &&
                messages.length ===
                  0 ? (
                  <div className="inbox-loading">
                    <div className="loading-spinner small" />

                    <span>
                      Checking for
                      messages...
                    </span>
                  </div>
                ) : messages.length ===
                  0 ? (
                  <div className="empty-inbox">
                    <div className="empty-icon">
                      <Mail
                        size={24}
                      />
                    </div>

                    <h3>
                      {isExpired
                        ? "This inbox has expired"
                        : "Your inbox is empty"}
                    </h3>

                    <p>
                      {isExpired
                        ? "Create a new temporary address to receive more emails."
                        : "Emails sent to your temporary address will appear here automatically."}
                    </p>

                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        isExpired
                          ? createInbox()
                          : loadMessages()
                      }
                      disabled={
                        loadingMessages
                      }
                    >
                      <RefreshCw
                        size={16}
                        className={
                          loadingMessages
                            ? "spin-icon"
                            : ""
                        }
                      />

                      {isExpired
                        ? "New address"
                        : "Check again"}
                    </button>
                  </div>
                ) : (
                  <div className="message-list">
                    {messages.map(
                      (
                        message,
                        index
                      ) => (
                        <button
                          type="button"
                          className={`message-row ${
                            !message.isRead
                              ? "message-unread"
                              : ""
                          }`}
                          key={
                            message.id ??
                            message.messageId ??
                            index
                          }
                          onClick={() =>
                            openMessage(
                              message
                            )
                          }
                        >
                          <div className="message-icon">
                            <Mail
                              size={18}
                            />
                          </div>

                          <div className="message-main">
                            <div className="message-subject">
                              {!message.isRead && (
                                <span className="unread-dot" />
                              )}

                              {getMessageSubject(
                                message
                              )}
                            </div>

                            <div className="message-sender">
                              {getMessageSender(
                                message
                              )}

                              {message
                                .attachments
                                ?.length >
                                0 && (
                                <span className="message-attachment-count">
                                  {" "}
                                  •{" "}
                                  {
                                    message
                                      .attachments
                                      .length
                                  }{" "}
                                  attachment
                                  {message
                                    .attachments
                                    .length !==
                                  1
                                    ? "s"
                                    : ""}
                                </span>
                              )}
                            </div>

                            <div className="message-preview">
                              {getMessageBody(
                                message
                              )
                                .replace(
                                  /\s+/g,
                                  " "
                                )
                                .trim()
                                .slice(
                                  0,
                                  140
                                )}
                            </div>
                          </div>

                          <div className="message-time">
                            {formatTime(
                              message.receivedAt ||
                                message.createdAt
                            )}
                          </div>
                        </button>
                      )
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* TRUST */}

            <section className="trust-row">
              <div>
                <ShieldCheck
                  size={17}
                />

                No account required
              </div>

              <div>
                <Clock3
                  size={17}
                />

                Auto-expires in 15 minutes
              </div>

              <div>
                <Mail
                  size={17}
                />

                Messages refresh automatically
              </div>
            </section>

            {/* HOW IT WORKS */}

            <section
              className="info-section"
              id="how-it-works"
            >
              <div className="section-kicker">
                How it works
              </div>

              <h2>
                Simple by design.
              </h2>

              <div className="info-grid">
                <article>
                  <span>01</span>

                  <h3>
                    Get an address
                  </h3>

                  <p>
                    A temporary email
                    address is created
                    automatically when
                    you open the site.
                  </p>
                </article>

                <article>
                  <span>02</span>

                  <h3>
                    Receive email
                  </h3>

                  <p>
                    Messages sent to
                    the address appear
                    automatically in
                    your inbox.
                  </p>
                </article>

                <article>
                  <span>03</span>

                  <h3>
                    Let it expire
                  </h3>

                  <p>
                    The inbox is
                    temporary and
                    disappears when its
                    lifetime ends.
                  </p>
                </article>
              </div>
            </section>

            {/* PRIVACY */}

            <section
              className="privacy-section"
              id="privacy"
            >
              <div className="privacy-icon">
                <ShieldCheck
                  size={21}
                />
              </div>

              <div>
                <h3>
                  Privacy by default
                </h3>

                <p>
                  Temp Mail does not
                  require an account
                  for this temporary
                  inbox. Keep sensitive
                  information out of
                  temporary email
                  addresses.
                </p>
              </div>
            </section>
          </>
        ) : (
          <section className="reader-section">
            <div className="reader-toolbar">
              <button
                type="button"
                className="back-button"
                onClick={
                  handleBackToInbox
                }
              >
                <ArrowLeft
                  size={17}
                />

                Back to inbox
              </button>

              <button
                type="button"
                className="danger-button"
                onClick={
                  deleteMessage
                }
                disabled={
                  deletingMessage
                }
              >
                <Trash2
                  size={16}
                />

                {deletingMessage
                  ? "Deleting..."
                  : "Delete"}
              </button>
            </div>

            <article className="message-reader">
              <header className="message-reader-header">
                <div className="reader-subject-row">
                  <h1>
                    {getMessageSubject(
                      selectedMessage
                    )}
                  </h1>

                  {!selectedMessage.isRead && (
                    <span className="reader-unread-badge">
                      Unread
                    </span>
                  )}
                </div>

                <div className="reader-meta">
                  <div>
                    <strong>
                      From
                    </strong>

                    <span>
                      {getMessageSender(
                        selectedMessage
                      )}
                    </span>
                  </div>

                  <div>
                    <strong>
                      To
                    </strong>

                    <span>
                      {getMessageRecipient(
                        selectedMessage
                      ) ||
                        inbox?.address ||
                        "Unknown recipient"}
                    </span>
                  </div>

                  <div>
                    <strong>
                      Received
                    </strong>

                    <span>
                      {formatDate(
                        selectedMessage.receivedAt ||
                          selectedMessage.createdAt
                      )}
                    </span>
                  </div>
                </div>
              </header>

              {/* ATTACHMENTS */}

              {selectedMessage
                .attachments
                ?.length >
                0 && (
                <div className="attachments-section">
                  <div className="attachments-heading">
                    <span>
                      Attachments
                    </span>

                    <small>
                      {
                        selectedMessage
                          .attachments
                          .length
                      }
                    </small>
                  </div>

                  <div className="attachment-list">
                    {selectedMessage.attachments.map(
                      (
                        attachment,
                        index
                      ) => (
                        <div
                          className="attachment-item"
                          key={
                            attachment.id ||
                            index
                          }
                        >
                          <div className="attachment-info">
                            <div className="attachment-icon">
                              <Download
                                size={16}
                              />
                            </div>

                            <div>
                              <strong>
                                {attachment.filename ||
                                  "Attachment"}
                              </strong>

                              <span>
                                {formatFileSize(
                                  attachment.size
                                )}

                                {attachment.contentType &&
                                  ` • ${attachment.contentType}`}
                              </span>
                            </div>
                          </div>

                          {attachment.id &&
                          attachment.downloadable !==
                            false ? (
                            <a
                              className="attachment-download"
                              href={`${API_BASE}/api/inboxes/${inbox.id}/messages/${selectedMessage.id}/attachments/${attachment.id}`}
                              download={
                                attachment.filename ||
                                "attachment"
                              }
                            >
                              <Download
                                size={15}
                              />

                              Download
                            </a>
                          ) : (
                            <span className="attachment-unavailable">
                              Unavailable
                            </span>
                          )}
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              {/* BODY */}

              <div className="message-body">
                {getMessageHtml(
                  selectedMessage
                ) ? (
                  <div className="html-email-container">
                    <iframe
                      title="Email content"
                      className="email-html-frame"
                      sandbox=""
                      referrerPolicy="no-referrer"
                      srcDoc={getMessageHtml(
                        selectedMessage
                      )}
                    />
                  </div>
                ) : (
                  <pre className="plain-email-body">
                    {getMessageBody(
                      selectedMessage
                    )}
                  </pre>
                )}
              </div>
            </article>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <span>
          Temp Mail
        </span>

        <span>
          Temporary email, made simple.
        </span>
      </footer>
    </div>
  );
}

export default App;
