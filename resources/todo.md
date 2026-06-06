

[ ] Decouple the API for video download form URL and put inside our DB uploadthing URL from video-translate jobs API no need to change anything but just add
[ ] This API always download video and put inside our DB and then we invoke translate API methods using AI LLM
[ ] Once that API is completed we again then upload final into our DB again and return the final same response as current one or give job ID as existing response