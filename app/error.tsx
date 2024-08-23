'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
} from '@nextui-org/react';
import { GoDownload } from 'react-icons/go';
import { LuRefreshCcw } from 'react-icons/lu';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error);
  }, [error]);

  const handleClose = () => {
    router.push('/'); // Optionally navigate to a safe page, like the home page
  };

  return (
    <Modal
      backdrop="blur"
      isOpen={true} // Keep modal open by default when an error occurs
      size="lg"
      className="dark:bg-zinc-950 dark:border-2 dark:border-zinc-800"
      scrollBehavior="inside"
      classNames={{
        base: 'w-[40%] max-w-none h-auto max-h-[60%]',
        wrapper: 'overflow-hidden',
      }}
      onClose={handleClose}
    >
      <ModalContent>
        <ModalHeader>
          <h2 className="text-xl font-bold">Something went wrong!</h2>
        </ModalHeader>
        <ModalBody>
          <span>{error.message || 'An unexpected error occurred'}</span>
          {error.digest || (
            <span>{`For more info, search logs for ${error.digest}`}</span>
          )}
        </ModalBody>
        <ModalFooter className="flex flex-col items-start space-y-2">
          <Button
            className="w-full"
            startContent={<GoDownload />}
            color="primary"
            variant="flat"
            onPress={handleClose}
            as="a"
            href="/api/download-logs"
          >
            Download Logs
          </Button>
          <Button
            className="w-full"
            startContent={<LuRefreshCcw />}
            color="primary"
            variant="flat"
            onPress={reset}
          >
            Try Again
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
