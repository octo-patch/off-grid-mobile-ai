package ai.offgridmobile.pdf

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import ai.offgridmobile.SafePromise
import io.legere.pdfiumandroid.PdfDocument
import io.legere.pdfiumandroid.PdfiumCore
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.Arguments
import java.io.File

class PDFExtractorModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val NAME = "PDFExtractorModule"
    }

    private fun safeReject(promise: Promise, code: String, message: String, throwable: Throwable? = null) =
        SafePromise(promise, NAME).reject(code, message, throwable)

    private fun safeResolve(promise: Promise, value: Any?) =
        SafePromise(promise, NAME).resolve(value)

    override fun getName(): String = NAME

    private fun extractPageText(doc: PdfDocument, pageIndex: Int, sb: StringBuilder) {
        val page = doc.openPage(pageIndex)
        val textPage = page.openTextPage()
        val charCount = textPage.textPageCountChars()
        if (charCount > 0) {
            val text = textPage.textPageGetText(0, charCount)
            if (text != null) sb.append(text).append("\n\n")
        }
        textPage.close()
        page.close()
    }

    @ReactMethod
    fun extractText(filePath: String, maxChars: Double, promise: Promise) {
        Thread {
            try {
                val file = File(filePath)
                if (!file.exists()) {
                    safeReject(promise, "PDF_ERROR", "File not found: $filePath")
                    return@Thread
                }

                val limit = maxChars.toInt()
                val core = PdfiumCore(reactApplicationContext)
                val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                val doc = core.newDocument(fd)
                val pageCount = doc.getPageCount()
                val sb = StringBuilder()

                for (i in 0 until pageCount) {
                    extractPageText(doc, i, sb)

                    if (sb.length >= limit) {
                        sb.setLength(limit)
                        sb.append("\n\n... [Extracted ${i + 1} of $pageCount pages]")
                        break
                    }
                }

                doc.close()
                fd.close()
                safeResolve(promise, sb.toString())
            } catch (e: Exception) {
                safeReject(promise, "PDF_ERROR", "Failed to extract text: ${e.message}", e)
            }
        }.start()
    }

    /**
     * Text of `count` pages from `start` (0-based), one string per page, plus the page count.
     * Pages stay separate so answers can cite them; nothing is capped.
     */
    @ReactMethod
    fun extractPages(filePath: String, start: Double, count: Double, promise: Promise) {
        Thread {
            try {
                val file = File(filePath.removePrefix("file://"))
                if (!file.exists()) {
                    safeReject(promise, "PDF_ERROR", "File not found: $filePath")
                    return@Thread
                }
                val core = PdfiumCore(reactApplicationContext)
                val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
                val doc = core.newDocument(fd)
                val pageCount = doc.getPageCount()
                val first = maxOf(0, start.toInt())
                val last = minOf(pageCount, first + maxOf(0, count.toInt()))
                val pages = Arguments.createArray()
                for (i in first until last) {
                    val sb = StringBuilder()
                    extractPageText(doc, i, sb)
                    pages.pushString(sb.toString())
                }
                doc.close()
                fd.close()
                val result = Arguments.createMap()
                result.putInt("pageCount", pageCount)
                result.putArray("pages", pages)
                safeResolve(promise, result)
            } catch (e: Exception) {
                safeReject(promise, "PDF_ERROR", "Failed to read pages: ${e.message}", e)
            }
        }.start()
    }
}
