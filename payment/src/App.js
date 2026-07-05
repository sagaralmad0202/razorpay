import { useEffect, useMemo, useState } from 'react';
import './App.css';

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const API_BASE_URL = (process.env.REACT_APP_API_BASE_URL || '').replace(/\/$/, '');
const SUCCESS_ROUTE = '#/payment-success';
const PAYMENT_STORAGE_KEY = 'razorpay:last-successful-payment';
const currencyFormatter = new Intl.NumberFormat('en-IN', {
  currency: 'INR',
  style: 'currency',
});

const initialForm = {
  amount: '499',
  contact: '9876543210',
  email: 'customer@example.com',
  name: 'Demo Customer',
};

function App() {
  const [routePath, setRoutePath] = useState(() => getCurrentRoute());
  const [completedPayment, setCompletedPayment] = useState(() => readStoredPayment());
  const [form, setForm] = useState(initialForm);
  const [isScriptReady, setIsScriptReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState({
    message: 'Razorpay Checkout is loading.',
    title: 'Ready soon',
    type: 'info',
  });

  const displayAmount = useMemo(() => {
    const amount = Number(form.amount);
    return currencyFormatter.format(Number.isFinite(amount) ? amount : 0);
  }, [form.amount]);

  useEffect(() => {
    const handlePopState = () => {
      setRoutePath(getCurrentRoute());
      setCompletedPayment(readStoredPayment());
    };

    window.addEventListener('hashchange', handlePopState);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('hashchange', handlePopState);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const handleLoad = () => {
      if (!isMounted) {
        return;
      }

      setIsScriptReady(true);
      setStatus({
        message: 'Enter customer details and click Pay to open Razorpay Checkout.',
        title: 'Checkout ready',
        type: 'success',
      });
    };

    const handleError = () => {
      if (!isMounted) {
        return;
      }

      setStatus({
        message: 'Could not load Razorpay Checkout. Check your internet connection and refresh.',
        title: 'Checkout unavailable',
        type: 'error',
      });
    };

    if (window.Razorpay) {
      handleLoad();
      return () => {
        isMounted = false;
      };
    }

    const existingScript = document.querySelector(`script[src="${CHECKOUT_SCRIPT_URL}"]`);

    if (existingScript) {
      existingScript.addEventListener('load', handleLoad);
      existingScript.addEventListener('error', handleError);

      return () => {
        isMounted = false;
        existingScript.removeEventListener('load', handleLoad);
        existingScript.removeEventListener('error', handleError);
      };
    }

    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);
    document.body.appendChild(script);

    return () => {
      isMounted = false;
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };
  }, []);

  const navigateTo = (path) => {
    window.history.pushState({}, '', path);
    setRoutePath(path);
  };

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  };

  const handleNewPayment = () => {
    sessionStorage.removeItem(PAYMENT_STORAGE_KEY);
    setCompletedPayment(null);
    navigateTo('/');
  };

  const handlePayment = async (event) => {
    event.preventDefault();

    if (!isScriptReady || !window.Razorpay) {
      setStatus({
        message: 'Razorpay Checkout is still loading. Try again in a moment.',
        title: 'Please wait',
        type: 'warning',
      });
      return;
    }

    setIsProcessing(true);
    setStatus({
      message: 'Creating a secure order on the server.',
      title: 'Starting payment',
      type: 'info',
    });

    try {
      const order = await postJson('/api/orders', {
        amount: form.amount,
        customer: {
          contact: form.contact,
          email: form.email,
          name: form.name,
        },
      });

      const checkoutKeyId = order.keyId || order.checkoutKeyId;

      if (!checkoutKeyId) {
        throw new Error('Razorpay Checkout key was missing from the order response. Restart the API server and check RAZORPAY_KEY_ID.');
      }

      const razorpay = new window.Razorpay({
        amount: order.amount,
        currency: order.currency,
        description: 'Secure checkout payment',
        handler: async (response) => {
          try {
            const verification = await postJson('/api/payments/verify', {
              order_id: order.id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });

            const paymentRecord = {
              amount: order.amount,
              businessName: order.businessName,
              currency: order.currency,
              customer: {
                contact: form.contact,
                email: form.email,
                name: form.name,
              },
              orderId: order.id,
              paidAt: new Date().toISOString(),
              paymentId: verification.paymentId,
              receipt: order.receipt,
              verified: verification.verified,
            };

            savePayment(paymentRecord);
            setCompletedPayment(paymentRecord);
            setStatus({
              message: `Payment ${verification.paymentId} was verified successfully.`,
              title: 'Payment successful',
              type: 'success',
            });
            navigateTo(SUCCESS_ROUTE);
          } catch (error) {
            setStatus({
              message: error.message,
              title: 'Verification failed',
              type: 'error',
            });
          } finally {
            setIsProcessing(false);
          }
        },
        key: checkoutKeyId,
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            setStatus({
              message: 'The payment window was closed before completion.',
              title: 'Payment cancelled',
              type: 'warning',
            });
          },
        },
        name: order.businessName,
        notes: {
          receipt: order.receipt,
        },
        order_id: order.id,
        prefill: {
          contact: form.contact,
          email: form.email,
          name: form.name,
        },
        retry: {
          enabled: true,
        },
        theme: {
          color: '#2563eb',
        },
      });

      razorpay.on('payment.failed', (response) => {
        setIsProcessing(false);
        setStatus({
          message:
            response.error?.description ||
            'Razorpay reported that the payment could not be completed.',
          title: 'Payment failed',
          type: 'error',
        });
      });

      razorpay.open();
    } catch (error) {
      setIsProcessing(false);
      setStatus({
        message: error.message,
        title: 'Payment could not start',
        type: 'error',
      });
    }
  };

  if (routePath === SUCCESS_ROUTE) {
    return (
      <PaymentSuccessPage
        onDownloadInvoice={downloadInvoice}
        onNewPayment={handleNewPayment}
        payment={completedPayment}
      />
    );
  }

  return (
    <div className="app-shell">
      <main className="checkout-layout">
        <section className="checkout-panel" aria-labelledby="checkout-title">
          <div className="panel-heading">
            <p className="eyebrow">Razorpay Checkout</p>
            <h1 id="checkout-title">Complete payment</h1>
            <p className="lede">Create an order and open Razorpay when the customer clicks Pay.</p>
          </div>

          <form className="payment-form" onSubmit={handlePayment}>
            <label>
              Customer name
              <input
                autoComplete="name"
                name="name"
                onChange={handleInputChange}
                required
                type="text"
                value={form.name}
              />
            </label>

            <label>
              Email
              <input
                autoComplete="email"
                name="email"
                onChange={handleInputChange}
                required
                type="email"
                value={form.email}
              />
            </label>

            <label>
              Mobile number
              <input
                autoComplete="tel"
                name="contact"
                onChange={handleInputChange}
                pattern="[0-9+ -]{8,16}"
                required
                type="tel"
                value={form.contact}
              />
            </label>

            <label>
              Amount
              <div className="amount-input">
                <span>INR</span>
                <input
                  min="1"
                  name="amount"
                  onChange={handleInputChange}
                  required
                  step="0.01"
                  type="number"
                  value={form.amount}
                />
              </div>
            </label>

            <button className="pay-button" disabled={isProcessing || !isScriptReady} type="submit">
              {isProcessing ? 'Opening checkout...' : `Pay ${displayAmount}`}
            </button>
          </form>
        </section>

        <aside className="summary-panel" aria-label="Order summary">
          <div>
            <p className="summary-label">Order total</p>
            <p className="summary-amount">{displayAmount}</p>
          </div>

          <div className={`status-card ${status.type}`} role="status">
            <span className="status-dot" />
            <div>
              <p className="status-title">{status.title}</p>
              <p>{status.message}</p>
            </div>
          </div>

          <div className="flow-list" aria-label="Payment flow">
            <div>
              <span>1</span>
              <p>Create order on server</p>
            </div>
            <div>
              <span>2</span>
              <p>Open Razorpay Checkout</p>
            </div>
            <div>
              <span>3</span>
              <p>Verify payment signature</p>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function PaymentSuccessPage({ onDownloadInvoice, onNewPayment, payment }) {
  if (!payment) {
    return (
      <div className="app-shell">
        <main className="success-layout">
          <section className="success-panel empty-success" aria-labelledby="missing-payment-title">
            <p className="eyebrow">Payment status</p>
            <h1 id="missing-payment-title">No verified payment found</h1>
            <p className="lede">Complete a payment first, then the invoice will be available here.</p>
            <button className="pay-button" onClick={onNewPayment} type="button">
              Go to payment
            </button>
          </section>
        </main>
      </div>
    );
  }

  const amount = formatDisplayAmount(payment.amount, payment.currency);
  const paidAt = formatDateTime(payment.paidAt);

  return (
    <div className="app-shell">
      <main className="success-layout">
        <section className="success-panel" aria-labelledby="success-title">
          <div className="success-mark" aria-hidden="true">PAID</div>
          <p className="eyebrow">Payment verified</p>
          <h1 id="success-title">Payment successful</h1>
          <p className="lede">Your payment was verified successfully. Download the invoice for your records.</p>

          <div className="success-total">
            <span>Amount paid</span>
            <strong>{amount}</strong>
          </div>

          <dl className="payment-details">
            <div>
              <dt>Payment ID</dt>
              <dd>{payment.paymentId}</dd>
            </div>
            <div>
              <dt>Order ID</dt>
              <dd>{payment.orderId}</dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd>{payment.receipt}</dd>
            </div>
            <div>
              <dt>Paid on</dt>
              <dd>{paidAt}</dd>
            </div>
            <div>
              <dt>Customer</dt>
              <dd>{payment.customer.name}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{payment.customer.email}</dd>
            </div>
          </dl>

          <div className="success-actions">
            <button className="pay-button" onClick={() => onDownloadInvoice(payment)} type="button">
              Download invoice
            </button>
            <button className="secondary-button" onClick={onNewPayment} type="button">
              Make another payment
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    body: JSON.stringify(payload),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || 'The payment request failed.');
  }

  return data;
}

function getCurrentRoute() {
  return window.location.hash || window.location.pathname;
}

function readStoredPayment() {
  try {
    const storedPayment = sessionStorage.getItem(PAYMENT_STORAGE_KEY);
    return storedPayment ? JSON.parse(storedPayment) : null;
  } catch (error) {
    return null;
  }
}

function savePayment(payment) {
  sessionStorage.setItem(PAYMENT_STORAGE_KEY, JSON.stringify(payment));
}

function downloadInvoice(payment) {
  const invoicePdf = createInvoicePdf(payment);
  const invoiceNumber = createInvoiceNumber(payment);
  const link = document.createElement('a');

  const objectUrl = URL.createObjectURL(invoicePdf);

  link.href = objectUrl;
  link.download = `${invoiceNumber}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function createInvoicePdf(payment) {
  const invoiceNumber = createInvoiceNumber(payment);
  const amount = formatInvoiceAmount(payment.amount, payment.currency);
  const paidAt = formatDateTime(payment.paidAt);
  const businessName = payment.businessName || 'Razorpay Store';
  const content = [
    pdfText('Payment Invoice', 54, 744, 24),
    pdfText(businessName, 54, 712, 13),
    pdfText(`Invoice No: ${invoiceNumber}`, 390, 744, 11),
    pdfText(`Date: ${paidAt}`, 390, 724, 11),
    pdfLine(54, 688, 558, 688),
    pdfText('Bill To', 54, 656, 14),
    pdfText(payment.customer.name, 54, 634, 11),
    pdfText(payment.customer.email, 54, 616, 11),
    pdfText(payment.customer.contact, 54, 598, 11),
    pdfText('Payment Details', 320, 656, 14),
    pdfText(`Payment ID: ${payment.paymentId}`, 320, 634, 10),
    pdfText(`Order ID: ${payment.orderId}`, 320, 616, 10),
    pdfText(`Receipt: ${payment.receipt}`, 320, 598, 10),
    pdfText('Status: Paid and verified', 320, 580, 10),
    pdfLine(54, 548, 558, 548),
    pdfText('Description', 54, 520, 12),
    pdfText('Amount', 462, 520, 12),
    pdfLine(54, 506, 558, 506),
    pdfText('Razorpay checkout payment', 54, 480, 11),
    pdfText(amount, 462, 480, 11),
    pdfLine(54, 454, 558, 454),
    pdfText('Total Paid', 360, 424, 14),
    pdfText(amount, 462, 424, 14),
    pdfText('This invoice was generated after server-side payment signature verification.', 54, 96, 9),
  ].join('\n');

  return new Blob([buildPdf(content)], { type: 'application/pdf' });
}

function buildPdf(content) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const offsets = [];
  let pdf = '%PDF-1.4\n';

  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;

  return pdf;
}

function pdfText(text, x, y, size) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function pdfLine(startX, startY, endX, endY) {
  return `${startX} ${startY} m ${endX} ${endY} l S`;
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .slice(0, 90);
}

function createInvoiceNumber(payment) {
  return `invoice-${payment.receipt || payment.paymentId || Date.now()}`.replace(/[^a-z0-9-]/gi, '-');
}

function formatDisplayAmount(amount, currency) {
  const majorAmount = Number(amount) / 100;

  if (currency === 'INR') {
    return currencyFormatter.format(Number.isFinite(majorAmount) ? majorAmount : 0);
  }

  return formatInvoiceAmount(amount, currency);
}

function formatInvoiceAmount(amount, currency = 'INR') {
  const majorAmount = Number(amount) / 100;
  return `${currency} ${Number.isFinite(majorAmount) ? majorAmount.toFixed(2) : '0.00'}`;
}

function formatDateTime(value) {
  const date = value ? new Date(value) : new Date();

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default App;